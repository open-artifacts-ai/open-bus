import type { CARD_TYP, LINK_TYP } from "@ob/shared";
import { importJWK, type JWK, SignJWT } from "jose";
import type { Env } from "../env.js";

/**
 * `TEST_CARD_KEY_X` from `@ob/shared/mocks`, copied as a literal: the mocks
 * entry also holds the private `d` (and msw), which must never be bundled
 * into the Worker. test/card.keys.test.ts pins it equal to the shared value;
 * test/card.keys.node.test.ts proves the bundle never carries `d`.
 */
export const SERVER_TEST_CARD_KEY_X =
  "S42KhnUIbfw2tK7UtvGNsrm9XBsDDXcAhVwo201LUGA";

/** The test key outside ENVIRONMENT=dev: nothing may be signed or published. */
export class TestKeyError extends Error {
  constructor() {
    super("Refusing the test card key outside dev");
    this.name = "TestKeyError";
  }
}

export type CardKeys = {
  kid: string;
  privateKey: CryptoKey;
  /** Public halves only: the current key first, then PREV. */
  jwks: { keys: JWK[] };
  ownerSalt: string;
};

type CardEnv = Pick<
  Env,
  | "ENVIRONMENT"
  | "CARD_SIGNING_KEY"
  | "CARD_SIGNING_KEY_PREV"
  | "CARD_OWNER_SALT"
>;

const SALT = /^[A-Za-z0-9_-]{48}$/;
/** An Ed25519 key or `d`: exactly 32 bytes, so 43 unpadded base64url chars. */
const KEY32 = /^[A-Za-z0-9_-]{43}$/;
/** `ob-<UTC yyyymmddThhmmssZ>-<6 hex>` fits; only the charset and length are enforced. */
const KID = /^[A-Za-z0-9._-]{1,64}$/;

/** Forgiving base64url decode (ignores spare low bits, as JWK importers do); null when invalid. */
function decode(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const b64url = (b: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** 32 bytes in their one canonical encoding: spare bits set would alias another string. */
function canonical32(s: unknown): boolean {
  if (typeof s !== "string" || !KEY32.test(s)) return false;
  const b = decode(s);
  return b?.length === 32 && b64url(b) === s;
}

const TEST_X_BYTES = decode(SERVER_TEST_CARD_KEY_X) as Uint8Array;

/**
 * Whether this is the test card key, comparing decoded bytes (so a
 * non-canonical encoding of the same `x` still matches). Takes a JWK, its
 * `x`, or a raw secret string (JSON JWK); anything unparseable is false.
 * Exported for Platform's Worker-wide test-key middleware.
 */
export function isTestCardKey(k: unknown): boolean {
  if (typeof k === "string" && k.trimStart().startsWith("{")) {
    try {
      k = JSON.parse(k);
    } catch {
      return false;
    }
  }
  const x = typeof k === "object" && k !== null ? (k as { x?: unknown }).x : k;
  if (typeof x !== "string") return false;
  const b = decode(x);
  return (
    b?.length === TEST_X_BYTES.length &&
    b.every((v, i) => v === TEST_X_BYTES[i])
  );
}

/** An Ed25519 OKP JWK per I11; `priv` says whether `d` must be present (or absent). */
function parseJwk(s: string, priv: boolean): JWK | null {
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const k = v as Record<string, unknown>;
  const ok =
    k.kty === "OKP" &&
    k.crv === "Ed25519" &&
    canonical32(k.x) &&
    typeof k.kid === "string" &&
    KID.test(k.kid) &&
    k.alg === "EdDSA" &&
    (priv ? canonical32(k.d) : !("d" in k));
  return ok ? (k as JWK) : null;
}

/** The public half as published: a whitelist, so `d` and anything else private is dropped. */
const publicJwk = (k: JWK): JWK => ({
  kty: "OKP",
  crv: "Ed25519",
  x: k.x,
  kid: k.kid,
  alg: "EdDSA",
});

async function load(env: CardEnv): Promise<CardKeys | null> {
  const { CARD_SIGNING_KEY: cur, CARD_SIGNING_KEY_PREV: prev } = env;
  // First, before any other check: the test key (signing or published) lets
  // anyone mint cards, so it is refused even when other secrets are broken.
  if (env.ENVIRONMENT !== "dev" && (isTestCardKey(cur) || isTestCardKey(prev)))
    throw new TestKeyError();
  const salt = env.CARD_OWNER_SALT;
  if (!cur || !salt || !SALT.test(salt)) return null;
  const key = parseJwk(cur, true);
  const old = prev === undefined || prev === "" ? null : parseJwk(prev, false);
  if (!key || (prev && !old) || (old && old.kid === key.kid)) return null;
  try {
    const privateKey = (await importJWK(
      { ...key, alg: "EdDSA" },
      "EdDSA",
    )) as CryptoKey;
    // Prove d and x are one pair, so the JWKS never publishes the wrong half.
    const publicKey = (await importJWK(publicJwk(key), "EdDSA")) as CryptoKey;
    const probe = new Uint8Array([1]);
    const sig = await crypto.subtle.sign("Ed25519", privateKey, probe);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, sig, probe)))
      return null;
    const keys = [publicJwk(key), ...(old ? [publicJwk(old)] : [])];
    if (JSON.stringify(keys).includes(key.d as string))
      throw new Error("private key material in the JWKS");
    return {
      kid: key.kid as string,
      privateKey,
      jwks: { keys },
      ownerSalt: salt,
    };
  } catch {
    return null;
  }
}

/** One entry per isolate: secrets change only on deploy. */
let cache: { id: string; keys: Promise<CardKeys | null> } | null = null;

/**
 * The card keys, or null when any card secret is absent or malformed. Throws
 * TestKeyError for the test key outside dev. The only path to a signing key
 * (DO card signer, /link, JWKS), so no signer needs its own check.
 */
export function loadCardKeys(env: CardEnv): Promise<CardKeys | null> {
  const id = JSON.stringify([
    env.ENVIRONMENT,
    env.CARD_SIGNING_KEY,
    env.CARD_SIGNING_KEY_PREV,
    env.CARD_OWNER_SALT,
  ]);
  if (cache?.id !== id) cache = { id, keys: load(env) };
  return cache.keys;
}

/**
 * `base64url(HMAC-SHA256(salt, "owner\n" + aud))`, unpadded; pairwise per
 * linked app. The HMAC key is the salt string's UTF-8 bytes. `aud` must be the
 * exact lowercased https origin (OriginSchema): any other spelling is a
 * different owner id.
 */
export async function ownerId(salt: string, aud: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return b64url(
    await crypto.subtle.sign("HMAC", k, enc.encode(`owner\n${aud}`)),
  );
}

/** A compact JWS with protected header `{alg: EdDSA, kid, typ}`. */
export function signJws(
  keys: CardKeys,
  typ: typeof CARD_TYP | typeof LINK_TYP,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ })
    .sign(keys.privateKey);
}
