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

const B64U = /^[A-Za-z0-9_-]+$/;
const SALT = /^[A-Za-z0-9_-]{48}$/;

/** An Ed25519 OKP JWK with a kid; `priv` says whether `d` must be present (or absent). */
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
    typeof k.x === "string" &&
    B64U.test(k.x) &&
    typeof k.kid === "string" &&
    k.kid.length > 0 &&
    (k.alg === undefined || k.alg === "EdDSA") &&
    (priv ? typeof k.d === "string" && B64U.test(k.d) : !("d" in k));
  return ok ? (k as JWK) : null;
}

/** The public half as published: no `d`, nothing private. */
function publicJwk(k: JWK): JWK {
  const out: JWK = {
    kty: "OKP",
    crv: "Ed25519",
    x: k.x,
    kid: k.kid,
    alg: "EdDSA",
  };
  if ("d" in out) throw new Error("private key material in the JWKS");
  return out;
}

async function load(env: CardEnv): Promise<CardKeys | null> {
  const { CARD_SIGNING_KEY: cur, CARD_SIGNING_KEY_PREV: prev } = env;
  const salt = env.CARD_OWNER_SALT;
  if (!cur || !salt || !SALT.test(salt)) return null;
  const key = parseJwk(cur, true);
  const old = prev === undefined || prev === "" ? null : parseJwk(prev, false);
  if (!key || (prev && !old) || (old && old.kid === key.kid)) return null;
  // Either the test key signing or the test key published lets anyone mint cards.
  if (
    env.ENVIRONMENT !== "dev" &&
    (key.x === SERVER_TEST_CARD_KEY_X || old?.x === SERVER_TEST_CARD_KEY_X)
  )
    throw new TestKeyError();
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

const b64url = (b: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** `base64url(HMAC-SHA256(salt, "owner\n" + aud))`, unpadded; pairwise per linked app. */
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
  typ: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keys.kid, typ })
    .sign(keys.privateKey);
}
