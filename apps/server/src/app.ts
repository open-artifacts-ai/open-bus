import { Hono } from "hono";
import {
  enforcePolicy,
  mw,
  type Policy,
  ROUTE_POLICY,
} from "./auth/route-policy.js";
import {
  cardKeyGuard,
  onTestCardKey,
  TEST_CARD_KEY_PROBLEM,
} from "./http/card-key-guard.js";
import { ApiError, toErrorResponse } from "./http/errors.js";
import {
  type AppEnv,
  SPA_CSP,
  securityHeaders,
  withSecurityHeaders,
} from "./http/middleware.js";
import { mountRoutes } from "./routes/index.js";
import { llmsTxt } from "./routes/llms.js";
import type { AppType } from "./routes/types.js";
import { version } from "./version.js";

/** Paths the Worker owns: never answered by the SPA (matched case-insensitively). */
const WORKER_PREFIX = /^\/(api|auth|approve|device|hub)(\/|$)/i;

/** Decode once; null when the path does not decode. */
function decodedPath(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
}

/** Collapse repeated slashes and resolve dot segments. */
function resolveSegments(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/**
 * The path as a router could see it: decoded, repeated slashes collapsed,
 * dot segments resolved. null when it does not decode (the caller 404s).
 */
export function normalizedPath(url: string): string | null {
  const p = decodedPath(url);
  return p === null ? null : resolveSegments(p);
}

/**
 * True when any view of the path is Worker-owned: the raw pathname, the
 * decoded one before dot resolution, or the normalized one. Checking only
 * the normalized form lets an encoded `%2F..` walk a raw `/api/...` path out
 * of its prefix; checking only the raw form misses `/%61pi` and `//api`.
 * An undecodable path counts as Worker-owned (404).
 */
export function isWorkerPath(url: string): boolean {
  const decoded = decodedPath(url);
  if (decoded === null) return true;
  return [new URL(url).pathname, decoded, resolveSegments(decoded)].some((p) =>
    WORKER_PREFIX.test(p),
  );
}

/** Unknown .txt/.md paths 404 (JSON) rather than fall to the SPA's HTML. */
function isTextDocPath(url: string): boolean {
  const decoded = decodedPath(url);
  return [
    new URL(url).pathname,
    decoded ?? "",
    decoded && resolveSegments(decoded),
  ]
    .filter(Boolean)
    .some((p) => /\.(txt|md)$/i.test(p as string));
}

/** `extraPolicy`: rules for routes a custom `mount` adds (tests). */
export function createApp(
  mount: (app: AppType) => void = mountRoutes,
  extraPolicy: Readonly<Record<string, Policy>> = {},
): AppType {
  const app: AppType = new Hono<AppEnv>();
  app.use(mw(securityHeaders()));
  // I11: the shared test card key refuses everything but /healthz.
  app.use(mw(cardKeyGuard()));
  // Fail closed: an unlisted route is 404 before any other middleware or handler.
  app.use("*", enforcePolicy({ ...ROUTE_POLICY, ...extraPolicy }));
  app.onError((e) => toErrorResponse(e));
  app.notFound(() => toErrorResponse(new ApiError("not_found", "Not found")));

  app.get("/healthz", (c) =>
    c.json({
      version: version(c.env),
      ...(onTestCardKey(c.env) ? { problem: TEST_CARD_KEY_PROBLEM } : {}),
    }),
  );
  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

  app.get("/llms.txt", (c) =>
    c.text(llmsTxt(c.env.APP_HOST), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    }),
  );

  mount(app);

  // SPA fallback, registered last: GET/HEAD off the Worker's own prefixes.
  // (run_worker_first: true, so the Worker sees every request.)
  app.on(["GET", "HEAD"], "*", async (c) => {
    if (isWorkerPath(c.req.url) || isTextDocPath(c.req.url) || !c.env.ASSETS)
      return toErrorResponse(new ApiError("not_found", "Not found"));
    // The outer middleware adds the rest (HSTS included) to this response.
    return withSecurityHeaders(await c.env.ASSETS.fetch(c.req.raw), undefined, {
      // Enforcing since FE9 staging (Chromium + WebKit) reported zero violations.
      "Content-Security-Policy": SPA_CSP,
    });
  });
  return app;
}

export const app = createApp();
