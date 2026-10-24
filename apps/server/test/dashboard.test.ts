import { AgentsResponseSchema, ApiErrorSchema, MeSchema, R } from "@ob/shared";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { mw, ROUTE_POLICY } from "../src/auth/route-policy.js";
import { mountRoutes } from "../src/routes/index.js";
import { e, machine, ns, ready, up, waitFor } from "./helpers.js";

// B2b's session middleware is not on this branch: a test-only middleware sets
// the `session` variable, and the three rows are opened (public) so the gate,
// which fails closed on `session` rows until B2b, lets the handler answer.

// B1's Session carries no email: /me reads env.OWNER_EMAIL (trimmed).
const OWNER = { uid: "owner" };
const env = { ...e, OWNER_EMAIL: "  Owner@Example.com \n" };
const { OWNER_EMAIL: _, ...noOwner } = e;
const OPEN = {
  "GET /api/v1/me": { public: "test" },
  "GET /api/v1/agents": { public: "test" },
  "GET /api/v1/events": { public: "test" },
};
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

const call = (session: unknown, path: string, en: object = env) =>
  appWith(session).fetch(new Request(`https://app.localhost${path}`), en, ctx);

async function errorCode(r: Response) {
  const body = ApiErrorSchema.parse(await r.json());
  return body.error;
}

describe("route policy", () => {
  it("lists the three dashboard routes as session routes", () => {
    for (const k of [
      "GET /api/v1/me",
      "GET /api/v1/agents",
      "GET /api/v1/events",
    ])
      expect(ROUTE_POLICY[k]).toEqual({ session: expect.any(String) });
  });

  it("the real app answers 401 without a session (gate fails closed)", async () => {
    const app = createApp();
    for (const p of [R.me, R.agents, R.events]) {
      const r = await app.fetch(
        new Request(`https://app.localhost${p}`),
        e,
        ctx,
      );
      expect(r.status).toBe(401);
      expect((await errorCode(r)).code).toBe("unauthorized");
    }
  });
});

describe("GET /api/v1/me", () => {
  it("returns the session owner with env.OWNER_EMAIL trimmed", async () => {
    const r = await call(OWNER, R.me);
    expect(r.status).toBe(200);
    const body = MeSchema.parse(await r.json());
    expect(body).toEqual({
      user: { id: "owner", email: "Owner@Example.com", name: null },
    });
  });

  it("passes a name through", async () => {
    const r = await call({ ...OWNER, name: "Leo" }, R.me);
    expect(MeSchema.parse(await r.json()).user.name).toBe("Leo");
  });

  it("ignores an email on the session", async () => {
    const r = await call({ ...OWNER, email: "evil@example.com" }, R.me);
    expect(MeSchema.parse(await r.json()).user.email).toBe("Owner@Example.com");
  });

  it.each([
    ["no session", undefined],
    ["a non-string name", { ...OWNER, name: 42 }],
    ["a non-string uid", { uid: 7 }],
    ["a non-object session", "owner"],
  ])("401s on %s, even past the gate", async (_, session) => {
    const r = await call(session, R.me);
    expect(r.status).toBe(401);
    expect((await errorCode(r)).code).toBe("unauthorized");
  });

  it("checks the session before reading OWNER_EMAIL", async () => {
    const r = await call(undefined, R.me, e);
    expect(r.status).toBe(401);
  });

  it.each([
    ["missing", noOwner],
    ["blank", { ...e, OWNER_EMAIL: "   " }],
    ["not an email", { ...e, OWNER_EMAIL: "nope" }],
  ])("500s when OWNER_EMAIL is %s", async (_, en) => {
    const r = await call(OWNER, R.me, en);
    expect(r.status).toBe(500);
    expect(await errorCode(r)).toEqual({
      code: "internal",
      message: "Owner profile unavailable",
    });
  });
});

describe("Cache-Control: no-store on /me and /agents", () => {
  it.each([
    ["/me 200", OWNER, R.me, 200],
    ["/me 401", undefined, R.me, 401],
    ["/me 500", OWNER, R.me, 500, noOwner],
    ["/agents 200", OWNER, R.agents, 200],
    ["/agents 400", OWNER, `${R.agents}?x=1`, 400],
    ["/agents 401", undefined, R.agents, 401],
  ] as const)("%s", async (_, session, path, status, en?: object) => {
    const r = await call(session, path, en);
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/v1/agents", () => {
  async function seed() {
    const m = await machine("Studio");
    const d = await ready(m.token);
    const a = ns("a");
    const b = ns("b");
    const g = `G${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    d.send(up("u1", "r1", "Alpha", a));
    await waitFor(d, "agent_ok");
    d.send(up("u2", "r2", "Beta", b));
    await waitFor(d, "agent_ok");
    d.send(up("u3", "r3", g, ns("g"), true));
    await waitFor(d, "agent_ok");
    return { d, a, b, g };
  }

  const list = async (q = "") => {
    const r = await call(OWNER, `${R.agents}${q}`);
    expect(r.status).toBe(200);
    return AgentsResponseSchema.parse(await r.json()).agents;
  };

  it("lists every namespace when namespace is absent", async () => {
    const { d, a, b, g } = await seed();
    const all = await list();
    const mine = all.filter(
      (x) => x.namespace === a || x.namespace === b || x.name === g,
    );
    expect(mine.map((x) => x.name).sort()).toEqual(["Alpha", "Beta", g].sort());
    expect(mine.every((x) => x.state === "live")).toBe(true);
    expect(mine[0]?.machineLabel).toBe("Studio");
    d.close();
  });

  it("lists one namespace plus the globals", async () => {
    const { d, a, b, g } = await seed();
    const one = await list(`?namespace=${encodeURIComponent(a)}`);
    const names = one.map((x) => x.name);
    expect(names).toContain("Alpha");
    expect(names).toContain(g);
    expect(names).not.toContain("Beta");
    expect(one.every((x) => x.namespace === a || x.global)).toBe(true);
    expect(one.some((x) => x.namespace === b)).toBe(false);
    d.close();
  });

  it.each([
    ["non-canonical", "?namespace=My%20Team"],
    ["empty", "?namespace="],
    ["repeated", "?namespace=a&namespace=b"],
  ])("400s a %s namespace", async (_, q) => {
    const r = await call(OWNER, `${R.agents}${q}`);
    expect(r.status).toBe(400);
    const err = await errorCode(r);
    expect(err).toMatchObject({
      code: "bad_request",
      details: { field: "namespace" },
    });
  });

  it.each([
    ["unknown", "?limit=5"],
    ["long unknown", `?${"k".repeat(5000)}=1`],
    ["repeated unknown", "?limit=1&limit=2"],
    ["unknown beside namespace", "?namespace=a&zzz=1"],
  ])("400s an %s query parameter without echoing its name", async (_, q) => {
    const r = await call(OWNER, `${R.agents}${q}`);
    expect(r.status).toBe(400);
    expect(await errorCode(r)).toMatchObject({
      code: "bad_request",
      details: { field: "query" },
    });
  });

  it("401s without a session, even past the gate", async () => {
    const r = await call(undefined, R.agents);
    expect(r.status).toBe(401);
    expect((await errorCode(r)).code).toBe("unauthorized");
  });
});
