import { getCookie } from "hono/cookie";
import type { Env } from "../env.js";
import type { FormCheck } from "../http/middleware.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { deriveKey } from "./keys.js";
import type { Session } from "./session.js";

/** The validated /link request, kept between GET /link and the confirm POST. */
export type LinkRequest = { aud: string; state: string };

/** How long a /link request (cookie and form token) lives. */
export const LINK_COOKIE_TTL_S = 600;
const TTL_MS = LINK_COOKIE_TTL_S * 1000;
/** A base64url JSON body and its HMAC; far above any valid request's size. */
const COOKIE_RE = /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_RE = /^(\d{13})\.([A-Za-z0-9_-]{43})$/;

type KeyEnv = Pick<Env, "SESSION_SECRET">;
type NameEnv = Pick<Env, "ENVIRONMENT">;

/** `__Host-` outside dev, like sessionCookieName, so no sibling host can plant one. */
export const linkCookieName = (env: NameEnv): string =>
  env.ENVIRONMENT === "dev" ? "ob_link" : "__Host-ob_link";

const attrs = (env: NameEnv) =>
  env.ENVIRONMENT === "dev"
    ? "HttpOnly; SameSite=Lax; Path=/"
    : "HttpOnly; Secure; SameSite=Lax; Path=/";

export const linkCookie = (value: string, env: NameEnv): string =>
  `${linkCookieName(env)}=${value}; ${attrs(env)}; Max-Age=${LINK_COOKIE_TTL_S}`;

export const clearLinkCookie = (env: NameEnv): string =>
  `${linkCookieName(env)}=; ${attrs(env)}; Max-Age=0`;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** `<base64url JSON {aud, state, exp}>.<HMAC under ob:link>`. */
export async function sealLink(
  env: KeyEnv,
  req: LinkRequest,
  now: number = Date.now(),
): Promise<string> {
  const { aud, state } = req;
  const body = b64urlEncode(
    enc.encode(JSON.stringify({ aud, state, exp: now + TTL_MS })),
  );
  return `${body}.${await hmacSign(await deriveKey(env, "ob:link"), body)}`;
}

/** The sealed request, or null when missing, malformed, tampered or expired. */
export async function openLink(
  env: KeyEnv,
  value: string | undefined,
  now: number = Date.now(),
): Promise<LinkRequest | null> {
  const m = value ? COOKIE_RE.exec(value) : null;
  if (!m) return null;
  const [, body = "", sig = ""] = m;
  if (!(await hmacVerify(await deriveKey(env, "ob:link"), body, sig)))
    return null;
  try {
    const raw = b64urlDecode(body);
    const v = raw && JSON.parse(dec.decode(raw));
    const { aud, state, exp } = v ?? {};
    if (
      typeof aud !== "string" ||
      typeof state !== "string" ||
      !Number.isSafeInteger(exp) ||
      exp <= now ||
      exp > now + TTL_MS
    )
      return null;
    return { aud, state };
  } catch {
    return null;
  }
}

/** The request this browser carries (the cookie the gate and handler both read). */
export const linkCookieValue = (c: Parameters<FormCheck>[0]) =>
  getCookie(c, linkCookieName(c.env));

type Bound = Pick<Session, "uid" | "gen">;

/** Bound to this exact sealed request (its HMAC) and to the session's uid and generation. */
const payload = (link: string, s: Bound, exp: number) =>
  `link\n${link.slice(link.indexOf(".") + 1)}\n${s.uid}\n${s.gen}\n${exp}`;

/**
 * The confirm form's CSRF token: `<exp ms>.<HMAC under ob:link-form>`. A token
 * rendered for one /link request cannot confirm another, and a logout voids it.
 */
export async function linkCsrf(
  env: KeyEnv,
  link: string,
  session: Bound,
  now: number = Date.now(),
): Promise<string> {
  const exp = now + TTL_MS;
  const key = await deriveKey(env, "ob:link-form");
  return `${exp}.${await hmacSign(key, payload(link, session, exp))}`;
}

/**
 * POST /link/confirm's FormCheck: one `csrf` field, minted for the ob_link
 * cookie this request carries and for this session, unexpired.
 */
export const linkFormCheck: FormCheck = async (c, session, form) => {
  const link = linkCookieValue(c);
  const tokens = form.getAll("csrf");
  const m = typeof tokens[0] === "string" ? TOKEN_RE.exec(tokens[0]) : null;
  if (!link || !COOKIE_RE.test(link) || tokens.length !== 1 || !m) return false;
  const exp = Number(m[1]);
  const now = Date.now();
  if (exp <= now || exp > now + TTL_MS) return false;
  const key = await deriveKey(c.env, "ob:link-form");
  return hmacVerify(key, payload(link, session, exp), m[2] as string);
};
