import type { Env } from "../env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
  sha256Hex,
} from "../util/crypto.js";
import { utf8Decoder, utf8Encoder } from "../util/text.js";
import { deriveKey } from "./keys.js";

/** OpenBus is single-owner: the session names the owner, never a user row. */
export const OWNER_UID = "owner";
const UID_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_AGE_S = 7 * 86400;
const MAX_COOKIE_LEN = 1024;

/**
 * The session cookie payload, signed with deriveKey("ob:session"). It is
 * bound to where it was minted: `env` (ENVIRONMENT), `host` (APP_HOST) and
 * `own` (SHA-256 hex of the lowercased OWNER_EMAIL), so a dev-login cookie,
 * another host's cookie or a previous owner's cookie never reads here even
 * when SESSION_SECRET is shared. `gen` must equal sessionGeneration(env).
 */
export type Session = {
  uid: string;
  exp: number;
  gen: number;
  env: Env["ENVIRONMENT"];
  host: string;
  own: string;
};

type SessionEnv = Pick<
  Env,
  "SESSION_SECRET" | "ENVIRONMENT" | "APP_HOST" | "OWNER_EMAIL"
>;

/**
 * The current session generation; a session minted under another one is
 * refused. Stub: always 0 until B3 stores the generation in the hub DO.
 * B1b's logout and B9's revoke-all bump it there, which signs out every
 * session at once.
 */
export async function sessionGeneration(_env: SessionEnv): Promise<number> {
  return 0;
}

const ownerHash = (env: Pick<Env, "OWNER_EMAIL">) =>
  sha256Hex(env.OWNER_EMAIL.trim().toLowerCase());

export async function signSession(
  env: SessionEnv,
  uid: string = OWNER_UID,
  now = Date.now(),
): Promise<string> {
  if (!UID_RE.test(uid)) throw new Error("invalid uid");
  const key = await deriveKey(env, "ob:session");
  const payload: Session = {
    uid,
    exp: now + MAX_AGE_S * 1000,
    gen: await sessionGeneration(env),
    env: env.ENVIRONMENT,
    host: env.APP_HOST,
    own: await ownerHash(env),
  };
  const p = b64urlEncode(utf8Encoder.encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(key, p)}`;
}

export async function readSession(
  env: SessionEnv,
  cookieValue: string | undefined,
  now = Date.now(),
): Promise<Session | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LEN) return null;
  try {
    const parts = cookieValue.split(".");
    if (parts.length !== 2) return null;
    const [p, sig] = parts as [string, string];
    const key = await deriveKey(env, "ob:session");
    if (!(await hmacVerify(key, p, sig))) return null;
    const raw = b64urlDecode(p);
    if (!raw) return null;
    const s = JSON.parse(utf8Decoder.decode(raw)) as Partial<Session> | null;
    if (!s || typeof s.uid !== "string" || !UID_RE.test(s.uid)) return null;
    if (typeof s.exp !== "number" || !Number.isFinite(s.exp) || s.exp <= now)
      return null;
    if (s.env !== env.ENVIRONMENT || s.host !== env.APP_HOST) return null;
    if (s.own !== (await ownerHash(env))) return null;
    if (s.gen !== (await sessionGeneration(env))) return null;
    return {
      uid: s.uid,
      exp: s.exp,
      gen: s.gen,
      env: s.env,
      host: s.host,
      own: s.own,
    };
  } catch {
    return null;
  }
}

/**
 * `__Host-` outside dev so no sibling or parent-domain host can plant a
 * session (cookie tossing / fixation). Every read, write and clear goes here.
 */
export function sessionCookieName(env: Pick<Env, "ENVIRONMENT">): string {
  return env.ENVIRONMENT === "dev" ? "ob_session" : "__Host-ob_session";
}

const attrs = (env: Pick<Env, "ENVIRONMENT">) =>
  env.ENVIRONMENT === "dev"
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";

export function sessionCookie(
  value: string,
  env: Pick<Env, "ENVIRONMENT">,
): string {
  return `${sessionCookieName(env)}=${value}; ${attrs(env)}; Max-Age=${MAX_AGE_S}`;
}

export function clearSessionCookie(env: Pick<Env, "ENVIRONMENT">): string {
  return `${sessionCookieName(env)}=; ${attrs(env)}; Max-Age=0`;
}
