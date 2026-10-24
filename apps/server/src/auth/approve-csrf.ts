import { normalizeUserCode } from "@ob/shared";
import type { Env } from "../env.js";
import type { FormCheck } from "../http/middleware.js";
import { hmacSign, hmacVerify } from "../util/crypto.js";
import { deriveKey } from "./keys.js";
import type { Session } from "./session.js";

/** How long an approval form token is accepted after the page rendered it. */
export const APPROVE_CSRF_TTL_MS = 600_000;

const TOKEN_RE = /^(\d{13})\.([A-Za-z0-9_-]{43})$/;

type Bound = Pick<Session, "uid" | "gen">;

/**
 * The signed payload: the raw (normalized) user code, the session's uid and
 * generation, and the expiry. Newlines cannot occur in any field (the code is
 * [A-Z2-9], uid is [a-z0-9_-], gen and exp are integers), so the encoding is
 * unambiguous.
 */
function payload(raw: string, s: Bound, exp: number): string {
  return `approve\n${raw}\n${s.uid}\n${s.gen}\n${exp}`;
}

/**
 * The approval form's CSRF token (B4): `<exp ms>.<HMAC>` under `ob:approve`,
 * bound to the user code and to the session's uid and generation, valid for
 * APPROVE_CSRF_TTL_MS. A token lifted from one approval cannot approve another
 * code, and a logout (generation bump) voids every token already rendered.
 * Throws on an invalid user code (a programmer error: the page only renders
 * for a known code).
 */
export async function approveCsrf(
  env: Pick<Env, "SESSION_SECRET">,
  userCode: string,
  session: Bound,
  now: number = Date.now(),
): Promise<string> {
  const raw = normalizeUserCode(userCode);
  if (!raw) throw new Error("approveCsrf: invalid user code");
  const exp = now + APPROVE_CSRF_TTL_MS;
  const key = await deriveKey(env, "ob:approve");
  return `${exp}.${await hmacSign(key, payload(raw, session, exp))}`;
}

/** Constant-time (hmacVerify); false for any malformed, foreign or expired token. */
export async function checkApproveCsrf(
  env: Pick<Env, "SESSION_SECRET">,
  userCode: string,
  session: Bound,
  token: unknown,
  now: number = Date.now(),
): Promise<boolean> {
  if (typeof token !== "string") return false;
  const raw = normalizeUserCode(userCode);
  const m = TOKEN_RE.exec(token);
  if (!raw || !m) return false;
  const exp = Number(m[1]);
  if (!Number.isSafeInteger(exp) || exp <= now) return false;
  if (exp > now + APPROVE_CSRF_TTL_MS) return false;
  const key = await deriveKey(env, "ob:approve");
  return hmacVerify(key, payload(raw, session, exp), m[2] as string);
}

const APPROVE_PATH = /^\/approve\/([^/]{1,64})$/;

/**
 * The approve form's FormCheck (POST /approve/:user_code): the `csrf` field
 * must be one token (not repeated) minted for the code in this request's path
 * and this session. The path is the one the handler's :user_code comes from.
 */
export const approveFormCheck: FormCheck = async (c, session, form) => {
  const m = APPROVE_PATH.exec(c.req.path);
  const tokens = form.getAll("csrf");
  if (!m || tokens.length !== 1) return false;
  let code: string;
  try {
    code = decodeURIComponent(m[1] as string);
  } catch {
    return false;
  }
  return checkApproveCsrf(c.env, code, session, tokens[0]);
};
