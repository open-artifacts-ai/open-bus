import type { Env } from "../env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { utf8Decoder, utf8Encoder } from "../util/text.js";
import { deriveKey } from "./keys.js";

/** OpenBus is single-owner: the session names the owner, never a user row. */
export const OWNER_UID = "owner";
const UID_RE = /^[a-z0-9_-]{1,32}$/;
export const MAX_AGE_S = 7 * 86400;
const MAX_COOKIE_LEN = 1024;

/** The session cookie payload, signed with deriveKey("ob:session"). */
export type Session = { uid: string; exp: number };

export async function signSession(
  env: Pick<Env, "SESSION_SECRET">,
  uid: string = OWNER_UID,
  now = Date.now(),
): Promise<string> {
  if (!UID_RE.test(uid)) throw new Error("invalid uid");
  const key = await deriveKey(env, "ob:session");
  const payload: Session = { uid, exp: now + MAX_AGE_S * 1000 };
  const p = b64urlEncode(utf8Encoder.encode(JSON.stringify(payload)));
  return `${p}.${await hmacSign(key, p)}`;
}

export async function readSession(
  env: Pick<Env, "SESSION_SECRET">,
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
    return { uid: s.uid, exp: s.exp };
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
