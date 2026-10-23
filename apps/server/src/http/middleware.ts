import type { MiddlewareHandler } from "hono";
import type { Env } from "../env.js";

// B2b adds the session variable and the session/csrf/sameOrigin middleware.
// biome-ignore lint/complexity/noBannedTypes: no request variables yet
export type AppEnv = { Bindings: Env; Variables: {} };

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
