import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { version } from "../src/version.js";

const testEnv = env as unknown as Env;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

/** Through the deployed entry point (src/index.ts), with the test config's env. */
const get = (p: string, init?: RequestInit, e: Env = testEnv) =>
  worker.fetch(
    new Request(`https://app.localhost${p}`, init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    e,
    ctx,
  );
type ErrorBody = { error: { code: string } };

const assets = {
  fetch: async () => new Response("<!doctype html>spa", { status: 200 }),
} as unknown as Fetcher;

describe("app shell", () => {
  it("serves /healthz with a version", async () => {
    const r = await get("/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ version: "dev" });
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("reports VERSION on /healthz when set", async () => {
    const r = await get("/healthz", undefined, {
      ...testEnv,
      VERSION: "0.6.0-abc1234",
    });
    expect(await r.json()).toEqual({ version: "0.6.0-abc1234" });
    expect(version({ VERSION: "  " })).toBe("dev");
  });

  it("404s an unlisted route before any handler runs", async () => {
    expect((await get("/api/v1/nope")).status).toBe(404);
    expect((await get("/approve/AAAA-AAAA", { method: "PUT" })).status).toBe(
      404,
    );
  });

  it("404s POST /healthz", async () => {
    const r = await get("/healthz", { method: "POST" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as ErrorBody).error.code).toBe("not_found");
  });

  it("disallows all crawlers in robots.txt", async () => {
    const r = await get("/robots.txt");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("User-agent: *\nDisallow: /\n");
  });

  it("SPA fallback 404s Worker prefixes and when ASSETS is unbound", async () => {
    expect(testEnv.ASSETS).toBeUndefined();
    for (const p of ["/", "/machines", "/api/x", "/hub/x"])
      expect((await get(p)).status, p).toBe(404);
    const bound = { ...testEnv, ASSETS: assets };
    expect((await get("/machines", undefined, bound)).status).toBe(200);
    for (const p of ["/api/x", "/auth/x", "/approve", "/device/x", "/hub/x"])
      expect((await get(p, undefined, bound)).status, p).toBe(404);
    // GET /hub is the daemon socket route (B5): never the SPA.
    expect((await get("/hub", undefined, bound)).status).toBe(400);
  });

  it("sets security headers on a 404", async () => {
    const r = await get("/api/v1/nope");
    expect(r.status).toBe(404);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("route policy gate", () => {
  const app = createApp(
    (a) => {
      a.get("/s", (c) => c.text("session handler ran"));
      a.get("/m", (c) => c.text("machine handler ran"));
      a.get("/unlisted", (c) => c.text("unlisted handler ran"));
    },
    { "GET /s": { session: "test" }, "GET /m": { machine: "test" } },
  );
  const req = (p: string) => app.request(`https://app.localhost${p}`, {}, env);

  it("fails a session rule closed with 401 without a session", async () => {
    const r = await req("/s");
    expect(r.status).toBe(401);
    expect(((await r.json()) as ErrorBody).error.code).toBe("unauthorized");
  });

  it("passes a machine rule to its handler", async () => {
    const r = await req("/m");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("machine handler ran");
  });

  it("404s a registered route the table does not list", async () => {
    const r = await req("/unlisted");
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain("handler ran");
  });
});
