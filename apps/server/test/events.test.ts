import { ApiErrorSchema, BusEventSchema, R } from "@ob/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mw } from "../src/auth/route-policy.js";
import type { Env } from "../src/env.js";
import { mountRoutes } from "../src/routes/index.js";
import { e } from "./helpers.js";

// B2b's session middleware is not on this branch: a test-only middleware sets
// the `session` variable and the row is opened (public) for the handler to run.

const EXP = 1_900_000_000_123;
const OWNER = { uid: "owner", exp: EXP };
const ORIGIN = "https://app.localhost";
const OPEN = { "GET /api/v1/events": { public: "test" } };
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

function appWith(session: unknown) {
  return createApp((app) => {
    if (session !== undefined)
      app.use(
        "/api/*",
        mw(async (c, next) => {
          (c as unknown as { set(k: string, v: unknown): void }).set(
            "session",
            session,
          );
          await next();
        }),
      );
    mountRoutes(app);
  }, OPEN);
}

const WS = { Upgrade: "websocket", Origin: ORIGIN };

const call = (
  session: unknown,
  headers: Record<string, string>,
  en: Env = e,
  { base = ORIGIN, method = "GET" } = {},
) =>
  appWith(session).fetch(
    new Request(`${base}${R.events}`, { headers, method }),
    en,
    ctx,
  );

/** A 101 as the DO answers it (the socket's other end is accepted here). */
function upgraded(): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** An env whose hub records the request it gets and answers `res`. */
function stubHub(res: () => Response) {
  const seen: Request[] = [];
  const HUB = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (req: Request) => {
        seen.push(req);
        return res();
      },
    }),
  } as unknown as Env["HUB"];
  return { env: { ...e, HUB }, seen };
}

async function errorOf(r: Response) {
  return ApiErrorSchema.parse(await r.json()).error;
}

describe("GET /api/v1/events (dashboard WebSocket)", () => {
  it.each([
    ["no session", undefined],
    ["a session without exp", { uid: "owner" }],
    ["a non-numeric exp", { uid: "owner", exp: "soon" }],
    ["an expired session", { uid: "owner", exp: Date.now() - 1 }],
  ])("401s on %s and never reaches the hub", async (_, session) => {
    const h = stubHub(upgraded);
    const r = await call(session, WS, h.env);
    expect(r.status).toBe(401);
    expect((await errorOf(r)).code).toBe("unauthorized");
    expect(h.seen).toHaveLength(0);
  });

  it.each([
    ["missing", {}],
    ["cross-site", { Origin: "https://evil.test" }],
    ["another port", { Origin: "https://app.localhost:8443" }],
    ["http scheme", { Origin: "http://app.localhost" }],
    ["null", { Origin: "null" }],
  ])("403s a %s Origin and never reaches the hub", async (_, o) => {
    const h = stubHub(upgraded);
    const r = await call(OWNER, { Upgrade: "websocket", ...o }, h.env);
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe("csrf");
    expect(h.seen).toHaveLength(0);
  });

  it("checks Origin against APP_HOST, not the request's own host", async () => {
    const h = stubHub(upgraded);
    const en = { ...h.env, APP_HOST: "bus.example" };
    const evil = "https://evil.workers.dev";
    const r = await call(OWNER, { ...WS, Origin: evil }, en, { base: evil });
    expect(r.status).toBe(403);
    expect((await errorOf(r)).code).toBe("csrf");
    expect(h.seen).toHaveLength(0);
    // The configured origin passes whatever host the request arrived on.
    const ok = await call(OWNER, { ...WS, Origin: "https://bus.example" }, en, {
      base: evil,
    });
    expect(ok.status).toBe(101);
    expect(h.seen).toHaveLength(1);
  });

  it.each([
    ["no Upgrade", { Origin: ORIGIN }],
    ["a non-websocket Upgrade", { Origin: ORIGIN, Upgrade: "h2c" }],
  ])("426s %s and never reaches the hub", async (_, headers) => {
    const h = stubHub(upgraded);
    const r = await call(OWNER, headers, h.env);
    expect(r.status).toBe(426);
    expect((await errorOf(r)).code).toBe("bad_request");
    expect(h.seen).toHaveLength(0);
  });

  it("426s HEAD (like a missing upgrade) and never reaches the hub", async () => {
    const h = stubHub(upgraded);
    const r = await call(OWNER, WS, h.env, { method: "HEAD" });
    expect(r.status).toBe(426);
    expect(h.seen).toHaveLength(0);
  });

  it("accepts Upgrade case-insensitively", async () => {
    const h = stubHub(upgraded);
    const r = await call(
      OWNER,
      { Origin: ORIGIN, Upgrade: "WebSocket" },
      h.env,
    );
    expect(h.seen).toHaveLength(1);
    expect(r.status).toBe(101);
  });

  it("sends the hub a fresh request: /events, upgrade and our exp only", async () => {
    const hubRes = upgraded();
    const h = stubHub(() => hubRes);
    const r = await call(
      OWNER,
      {
        ...WS,
        "x-ob-session-exp": "99999999999999",
        "x-ob-machine-id": "m1",
        cookie: "s=1",
        authorization: "Bearer x",
      },
      h.env,
    );
    expect(h.seen).toHaveLength(1);
    const fwd = h.seen[0] as Request;
    expect(new URL(fwd.url).pathname).toBe("/events");
    expect(fwd.headers.get("x-ob-session-exp")).toBe(String(EXP));
    expect(fwd.headers.get("upgrade")).toBe("websocket");
    for (const k of ["x-ob-machine-id", "cookie", "authorization", "origin"])
      expect(fwd.headers.get(k), k).toBeNull();
    // The hub's 101 comes back with its socket.
    expect(r.status).toBe(101);
    expect(r.webSocket).toBe(hubRes.webSocket);
  });

  it.each([
    ["an error", () => new Response("Not found", { status: 404 })],
    ["a 200", () => new Response("ok")],
  ])("maps %s from the hub to a 500 internal envelope", async (_, res) => {
    let cancelled = false;
    const h = stubHub(() => {
      const r = res();
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: r.status });
    });
    const r = await call(OWNER, WS, h.env);
    expect(r.status).toBe(500);
    expect((await errorOf(r)).code).toBe("internal");
    expect(cancelled).toBe(true);
  });

  it("passes the real hub's 101 through, socket and all", async () => {
    const r = await call(OWNER, WS);
    expect(r.status).toBe(101);
    const ws = r.webSocket;
    if (!ws) throw new Error("no webSocket");
    ws.accept();
    const first = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), 3000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(t);
        resolve(String(ev.data));
      });
    });
    expect(BusEventSchema.parse(JSON.parse(first))).toEqual({ type: "hello" });
    ws.close(1000, "done");
  });
});
