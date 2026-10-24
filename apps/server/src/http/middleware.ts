import { CSRF_HEADER } from "@ob/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { Session } from "../auth/session.js";
import type { Env } from "../env.js";
import { ApiError, toErrorResponse } from "./errors.js";
import { isSameOrigin } from "./origin.js";

/**
 * Pinned for Frontend: the policy gate sets `session` (B1's Session) on every
 * `{session}` row, only after readSession succeeds, so handlers on those
 * routes can rely on `c.get("session")`. It is unset on any other route.
 */
export type AppVariables = { session: Session };
export type AppEnv = { Bindings: Env; Variables: AppVariables };

export function withSecurityHeaders(res: Response): Response {
  if (res.status === 101) return res;
  const set = (h: Headers) => {
    h.set("X-Content-Type-Options", "nosniff");
    h.set("Referrer-Policy", "strict-origin-when-cross-origin");
    h.set("X-Frame-Options", "DENY");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("X-Robots-Tag", "noindex, nofollow");
  };
  try {
    set(res.headers);
    return res;
  } catch {
    // Immutable headers (e.g. a Response passed through from ASSETS).
    const out = new Response(res.body, res);
    set(out.headers);
    return out;
  }
}

export const securityHeaders =
  (): MiddlewareHandler<AppEnv> => async (c, next) => {
    await next();
    c.res = withSecurityHeaders(c.res);
  };

/** A refusal (401, 403) is per-user and must never be cached. */
export function refuse(e: ApiError): Response {
  const res = toErrorResponse(e);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** The only methods exempt from CSRF; every other method (PROPFIND, PURGE, OPTIONS...) is checked. */
const SAFE = new Set(["GET", "HEAD"]);

/**
 * CSRF for a cookie-authenticated request: any method but GET and HEAD must carry
 * `X-OB-Request: 1` and be same-origin (isSameOrigin). GET and HEAD (and the
 * /events WebSocket upgrade, which checks its own Origin) pass. Returns the
 * refusal, or null when the request may proceed.
 */
export function csrfRefusal(c: Context<AppEnv>): ApiError | null {
  if (SAFE.has(c.req.method)) return null;
  if (c.req.header(CSRF_HEADER) !== "1")
    return new ApiError("csrf", `Missing ${CSRF_HEADER}: 1 header`);
  if (!isSameOrigin(c.env, c.req.raw))
    return new ApiError("csrf", "Cross-origin request refused");
  return null;
}
