import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";

/**
 * EVERY middleware (anything registered with `app.use` or that calls `next()`)
 * MUST be wrapped with `mw()`. The gate enforces exactly one rule: the first
 * matched route after it that is not tagged. An untagged middleware is taken
 * as the answering route, so if its path is listed (e.g. `"ALL /api/*"`) the
 * gate passes on its rule and the real handler behind it runs unchecked
 * (pinned by test/hardening.test.ts). Never list a middleware in the table.
 *
 * Real middleware, tagged at registration (`mw`). The gate skips exactly
 * these when it looks for the route that will answer; anything else matched
 * is a handler and needs a policy.
 */
const MIDDLEWARE = new WeakSet<object>();
export function mw<T extends object>(handler: T): T {
  MIDDLEWARE.add(handler);
  return handler;
}
export const isMiddleware = (handler: object): boolean =>
  MIDDLEWARE.has(handler);

/**
 * Every route's access rule. A route with no entry answers 404 before its
 * handler runs, so a new route cannot ship unguarded. `machine` routes verify
 * the bearer token in their handler (the gate only proves the table lists them).
 */
export type Policy =
  | { public: string }
  | { session: string }
  | { machine: string };

/** Keyed `${method} ${path}` as Hono registers the route. */
export const ROUTE_POLICY: Readonly<Record<string, Policy>> = {
  "GET /healthz": { public: "health probe" },
  "GET /robots.txt": { public: "robots" },
  "GET /hub": { machine: "daemon socket" },
  // Hono routes HEAD as GET, so this row covers HEAD too.
  "GET /*": { public: "SPA and assets" },
};

type Target = { method: string; path: string };

/**
 * The route that will answer: the first matched route after this middleware
 * that is not tagged middleware. (`c.req.routePath` inside `app.use("*")` is
 * the middleware's own path, not the answering route's.)
 */
export function targetRoute(c: Context): Target | null {
  const routes = matchedRoutes(c);
  for (let i = c.req.routeIndex + 1; i < routes.length; i++) {
    const r = routes[i];
    if (!r || isMiddleware(r.handler)) continue;
    return { method: r.method, path: r.path };
  }
  return null;
}

/** App gate: looks the answering route up in `table` and enforces it. */
export const enforcePolicy = (
  table: Readonly<Record<string, Policy>> = ROUTE_POLICY,
): MiddlewareHandler<AppEnv> =>
  mw(async (c, next) => {
    const t = targetRoute(c);
    // No answering route: the app's notFound handler answers 404.
    if (!t) return next();
    const p = table[`${t.method} ${t.path}`];
    if (!p) throw new ApiError("not_found", "Not found");
    // Fail closed until B2b wires sessions.
    if ("session" in p)
      throw new ApiError("unauthorized", "Sign in to continue");
    await next();
  });
