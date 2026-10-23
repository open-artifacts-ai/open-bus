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

/** Paths the Worker owns: never answered by the SPA. */
const WORKER_PREFIX = /^\/(api|auth|approve|device|hub)(\/|$)/;

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
    const path = new URL(c.req.url).pathname;
    if (WORKER_PREFIX.test(path) || !c.env.ASSETS)
      return toErrorResponse(new ApiError("not_found", "Not found"));
    return c.env.ASSETS.fetch(c.req.raw);
  });
  return app;
}

export const app = createApp();
