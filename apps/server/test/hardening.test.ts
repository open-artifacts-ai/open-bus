// Fix round 1 for the B2a adversarial review (adv-B2a-report.md) and the spec review.
import { env } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mw } from "../src/auth/route-policy.js";
import type { Env } from "../src/env.js";
import { ApiError, toErrorResponse } from "../src/http/errors.js";
import worker from "../src/index.js";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
type ErrorBody = { error: { code: string; message: string } };

const hits: string[] = [];
const ASSETS = {
  fetch: async (r: Request) => {
    hits.push(new URL(r.url).pathname);
    return new Response("<!doctype html>spa", { status: 200 });
  },
} as unknown as Fetcher;
const bound = { ...(env as unknown as Env), ASSETS };
const fetchWorker = (p: string, init?: RequestInit, e: Env = bound) =>
  worker.fetch(
    new Request(`https://app.localhost${p}`, init) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    e,
    ctx,
  );

const expectSecurityHeaders = (r: Response) => {
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
};

describe("SPA fallback guards the decoded path", () => {
  for (const p of [
    "/%61pi/v1/x",
    "/%61uth/x",
    "/h%75b",
    "/api%2Fv1",
    "//api/x",
    "//hub",
    "/api/./x",
    "/API/x",
    "/Hub",
    "/x/../api/x",
    "/%E0%A4%A", // malformed escape: fails to decode
  ])
    it(`404s ${p} without calling ASSETS`, async () => {
      hits.length = 0;
      const r = await fetchWorker(p);
      expect(r.status, p).toBe(404);
      expect(hits, p).toEqual([]);
    });

  it("still serves ordinary SPA paths", async () => {
    hits.length = 0;
    expect((await fetchWorker("/machines")).status).toBe(200);
    expect((await fetchWorker("/apiary")).status).toBe(200);
    expect(hits).toEqual(["/machines", "/apiary"]);
  });

  it("answers HEAD on an SPA path like GET", async () => {
    const r = await fetchWorker("/machines", { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    expectSecurityHeaders(r);
  });
});

describe("total error handling", () => {
  const app = createApp(
    (a) => {
      a.get("/str", () => {
        throw "boom: token=secret";
      });
      a.get("/obj", () => {
        throw { message: "token=secret" };
      });
      a.get("/err", () => {
        throw new Error("token=secret");
      });
    },
    {
      "GET /str": { machine: "t" },
      "GET /obj": { machine: "t" },
      "GET /err": { machine: "t" },
    },
  );
  const viaWorker = {
    fetch: (req: Request, e: Env, c: ExecutionContext) => app.fetch(req, e, c),
  };

  it("a thrown Error is a 500 internal through onError, headers set", async () => {
    const r = await app.request("https://app.localhost/err", {}, env);
    expect(r.status).toBe(500);
    expectSecurityHeaders(r);
    expect(await r.json()).toEqual({
      error: { code: "internal", message: "Internal error" },
    });
  });

  for (const p of ["/str", "/obj"])
    it(`a non-Error throw (${p}) is a 500 envelope with headers via the entry point`, async () => {
      const { handle } = await import("../src/handle.js");
      const r = await handle(
        viaWorker,
        new Request(`https://app.localhost${p}`),
        env as unknown as Env,
        ctx,
      );
      expect(r.status).toBe(500);
      expectSecurityHeaders(r);
      const body = await r.text();
      expect(body).not.toContain("secret");
      expect(JSON.parse(body)).toEqual({
        error: { code: "internal", message: "Internal error" },
      });
    });

  it("maps HTTPException status to a matching code, else internal", async () => {
    const code = async (status: number) => {
      const r = toErrorResponse(
        new HTTPException(status as 400, { message: "m" }),
      );
      return [r.status, ((await r.json()) as ErrorBody).error.code];
    };
    expect(await code(400)).toEqual([400, "bad_request"]);
    expect(await code(401)).toEqual([401, "unauthorized"]);
    expect(await code(404)).toEqual([404, "not_found"]);
    expect(await code(409)).toEqual([409, "conflict"]);
    expect(await code(413)).toEqual([413, "too_large"]);
    expect(await code(429)).toEqual([429, "rate_limited"]);
    expect(await code(418)).toEqual([500, "internal"]);
    expect(await code(503)).toEqual([500, "internal"]);
  });

  it("accepts unknown and never echoes the thrown value", async () => {
    const r = toErrorResponse("token=secret");
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("secret");
    expect(toErrorResponse(new ApiError("not_found", "x")).status).toBe(404);
  });
});

describe("gate responses carry security headers", () => {
  const app = createApp(
    (a) => {
      a.get("/s", (c) => c.text("session handler ran"));
      a.get("/unlisted", (c) => c.text("unlisted handler ran"));
    },
    { "GET /s": { session: "t" } },
  );
  it("on the 404 for an unlisted route", async () => {
    const r = await app.request("https://app.localhost/unlisted", {}, env);
    expect(r.status).toBe(404);
    expectSecurityHeaders(r);
  });
  it("on the 401 for a session rule", async () => {
    const r = await app.request("https://app.localhost/s", {}, env);
    expect(r.status).toBe(401);
    expectSecurityHeaders(r);
  });
});

describe("gate enforces only the first matched non-mw() handler (by design)", () => {
  const build = (tag: boolean) => {
    const passthrough = async (_c: unknown, next: () => Promise<void>) => {
      await next();
    };
    return createApp(
      (a) => {
        a.use("/api/*", tag ? mw(passthrough) : passthrough);
        a.get("/api/v1/me", (c) => c.text("session handler ran"));
      },
      { "ALL /api/*": { public: "x" }, "GET /api/v1/me": { session: "me" } },
    );
  };
  it("UNSAFE: an untagged middleware is taken as the answering route", async () => {
    const r = await build(false).request(
      "https://app.localhost/api/v1/me",
      {},
      env,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("session handler ran");
  });
  it("tagged with mw(), the session rule behind it is enforced", async () => {
    const r = await build(true).request(
      "https://app.localhost/api/v1/me",
      {},
      env,
    );
    expect(r.status).toBe(401);
  });
});
