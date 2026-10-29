// Agent card keys (I11, spec 2026-10-29-agent-card-design.md "Keys"). The
// Worker signs cards with CARD_SIGNING_KEY; CARD_SIGNING_KEY_PREV is the
// previous key's public half, published in /.well-known/jwks.json so cards
// signed before a rotation verify until they expire.
import { randomBytes, webcrypto } from "node:crypto";

export const CARD_KEY = "CARD_SIGNING_KEY";
export const CARD_KEY_PREV = "CARD_SIGNING_KEY_PREV";
export const CARD_SALT = "CARD_OWNER_SALT";
/** --rotate-card-key refuses to run again within this long, unless --force. */
export const ROTATE_MIN_MS = 24 * 3600_000;

export type PublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
};
export type PrivateJwk = PublicJwk & { d: string };

/** `ob-<UTC yyyymmddThhmmssZ>-<6 hex>`: the key's creation time, read back by the rotation guard. */
const KID = /^ob-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/;

export function kidFor(now: number): string {
  const t = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `ob-${t}Z-${randomBytes(3).toString("hex")}`;
}

/** The creation time a kid carries (ms), or undefined for any other shape. */
export function kidTime(kid: string): number | undefined {
  const m = KID.exec(kid);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(t) ? undefined : t;
}

export async function generateCardKey(now: number): Promise<PrivateJwk> {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  if (!jwk.x || !jwk.d) throw new Error("Ed25519 export had no x or d");
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x,
    d: jwk.d,
    kid: kidFor(now),
    alg: "EdDSA",
  };
}

/** The public half: never carries `d`. */
export const publicOf = (k: PublicJwk): PublicJwk => ({
  kty: "OKP",
  crv: "Ed25519",
  x: k.x,
  kid: k.kid,
  alg: "EdDSA",
});

/** The current key in a JWKS body: the Ed25519 key whose kid is newest. */
export function currentOf(body: unknown): PublicJwk | undefined {
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return undefined;
  let best: { k: PublicJwk; t: number } | undefined;
  for (const k of keys as Partial<PublicJwk>[]) {
    if (k?.kty !== "OKP" || k.crv !== "Ed25519") continue;
    if (typeof k.x !== "string" || typeof k.kid !== "string") continue;
    const t = kidTime(k.kid);
    if (t === undefined) continue;
    if (!best || t > best.t) best = { k: k as PublicJwk, t };
  }
  return best && publicOf(best.k);
}

/** 36 random bytes, base64url: 48 chars. */
export const newSalt = () => randomBytes(36).toString("base64url");
