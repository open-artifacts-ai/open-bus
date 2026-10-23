import { Hono } from "hono";
import {
  enforcePolicy,
  mw,
  type Policy,
  ROUTE_POLICY,
} from "./auth/route-policy.js";
import { ApiError, toErrorResponse } from "./http/errors.js";
import { type AppEnv, securityHeaders } from "./http/middleware.js";
import { mountRoutes } from "./routes/index.js";
import type { AppType } from "./routes/types.js";
import { version } from "./version.js";

/** Paths the Worker owns: never answered by the SPA (matched case-insensitively). */
const WORKER_PREFIX = /^\/(api|auth|approve|device|hub)(\/|$)/i;

/**
 * The path as a router could see it: decoded, repeated slashes collapsed,
 * dot segments resolved. null when it does not decode (the caller 404s).
 */
export function normalizedPath(url: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** `extraPolicy`: rules for routes a custom `mount` adds (tests). */
export function createApp(
  mount: (app: AppType) => void = mountRoutes,
  extraPolicy: Readonly<Record<string, Policy>> = {},
): AppType {
  const app: AppType = new Hono<AppEnv>();
  app.use(mw(securityHeaders()));
  // Fail closed: an unlisted route is 404 before any other middleware or handler.
  app.use("*", enforcePolicy({ ...ROUTE_POLICY, ...extraPolicy }));
  app.onError((e) => toErrorResponse(e));
  app.notFound(() => toErrorResponse(new ApiError("not_found", "Not found")));

  app.get("/healthz", (c) => c.json({ version: version(c.env) }));
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

  mount(app);

  // SPA fallback, registered last: GET/HEAD off the Worker's own prefixes.
  // (run_worker_first: true, so the Worker sees every request.)
  app.on(["GET", "HEAD"], "*", (c) => {
    const path = normalizedPath(c.req.url);
    if (path === null || WORKER_PREFIX.test(path) || !c.env.ASSETS)
      return toErrorResponse(new ApiError("not_found", "Not found"));
    return c.env.ASSETS.fetch(c.req.raw);
  });
  return app;
}

export const app = createApp();
