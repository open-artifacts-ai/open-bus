// SPA guard vs odd paths (ported from the B2a round-2 adversarial probe).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { normalizedPath } from "../src/app.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
const hits: string[] = [];
const ASSETS = {
  fetch: async (r: Request) => {
    hits.push(new URL(r.url).pathname);
    return new Response("<!doctype html>spa", { status: 200 });
  },
} as unknown as Fetcher;
const bound = { ...(env as unknown as Env), ASSETS };
const go = (p: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`https://app.localhost${p}`, init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    bound,
    ctx,
  );

describe("adv: must 404 (Worker-owned prefix)", () => {
  for (const p of [
    "/%2e%2e/api/x",
    "/x/%2e%2e/api",
    "/\\api/x", // URL parser turns \ into /
    "/x\\..\\api",
    "/%C0%AF", // overlong '/'
    "/%ED%A0%80", // lone surrogate
    "/%FF",
    "/%",
    "/a%2Fb%2F..%2F..%2Fapi", // decodes to /a/b/../../api
    "/HuB/",
    "/AUTH",
    "/x/..%2Fapi", // decodes to /x/../api -> /api
  ])
    it(`404 ${p}`, async () => {
      hits.length = 0;
      const r = await go(p);
      expect(r.status, p).toBe(404);
      expect(hits, p).toEqual([]);
    });
});

describe("adv: a dot-segment path that resolves to /hub", () => {
  it("/x/%2E%2e/hub is the /hub socket route (400 without an upgrade), never ASSETS", async () => {
    hits.length = 0;
    const r = await go("/x/%2E%2e/hub");
    expect(r.status).toBe(400);
    expect(hits).toEqual([]);
  });
});

describe("adv: raw path under a Worker prefix that normalizes OUT of it", () => {
  // Raw /api/... (Hono matched nothing) but %2F-encoded dots climb out after decode.
  for (const p of [
    "/api/..%2Fmachines",
    "/api%2F..%2Fmachines",
    "/hub/..%2F..%2Fx",
    "/api/x%2F..%2F..%2Fmachines",
  ])
    it(`404 ${p} (SPA must not answer a raw Worker-prefix path)`, async () => {
      hits.length = 0;
      const r = await go(p);
      expect(r.status, `${p} -> ${hits.join(",")}`).toBe(404);
    });
});

describe("adv: decode once only (behavior record)", () => {
  it("double-encoded %2561pi is NOT treated as /api (single decode)", () => {
    expect(normalizedPath("https://h/%2561pi/v1")).toBe("/%61pi/v1");
  });
  it("NUL after prefix is not the prefix", () => {
    expect(normalizedPath("https://h/api%00/x")).toBe("/api\0/x");
  });
  it("%5C backslash stays a char", () => {
    expect(normalizedPath("https://h/%5Capi/x")).toBe("/\\api/x");
  });
});

describe("adv: CPU cost", () => {
  it("normalizes a 64 KiB path of dot segments and slashes quickly", () => {
    const paths = [
      `/${"%2e%2e%2f".repeat(8000)}`,
      `/${"a/".repeat(32000)}`,
      `/${"/".repeat(64000)}`,
      `/${"%41".repeat(21000)}`,
      `/${"../".repeat(21000)}api`,
    ];
    for (const p of paths) {
      const t = performance.now();
      for (let i = 0; i < 20; i++) normalizedPath(`https://h${p}`);
      const ms = (performance.now() - t) / 20;
      expect(ms).toBeLessThan(20);
    }
    expect(normalizedPath(`https://h/${"../".repeat(21000)}api`)).toBe("/api");
  });
});
