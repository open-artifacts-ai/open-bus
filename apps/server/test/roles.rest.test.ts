import { SELF } from "cloudflare:test";
import {
  AgentsResponseSchema,
  ApiErrorSchema,
  type BusEvent,
  BusEventSchema,
  CSRF_HEADER,
  EVENTS_DO_PATH,
  LIMITS,
  newId,
  OWNER_ORG_ID,
  R,
  RolesResponseSchema,
  SESSION_EXP_HEADER,
  SESSION_GEN_HEADER,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { hub } from "../src/hub/stub.js";
import {
  type Daemon,
  e,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

// AC2b: owner-only roles REST through the deployed entry point and the gate.

const ORIGIN = `https://${e.APP_HOST}`;
const cookie = async () => `${sessionCookieName(e)}=${await signSession(e)}`;
const owner = async (): Promise<Record<string, string>> => ({
  cookie: await cookie(),
  origin: ORIGIN,
  [CSRF_HEADER]: "1",
});

let seq = 0;
const id = (t: string) => `${t}${++seq}`;

const put = (path: string, body: unknown, headers: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const del = (path: string, headers: Record<string, string>) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "DELETE", headers });

async function error(r: Response) {
  return ApiErrorSchema.parse(await r.json()).error;
}

async function roles() {
  const r = await SELF.fetch(`${ORIGIN}${R.roles}`, {
    headers: { cookie: await cookie() },
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  return RolesResponseSchema.parse(await r.json()).roles;
}

async function register(
  d: Daemon,
  ref: string,
  name: string,
  namespace: string,
): Promise<string> {
  d.send(up(id("u"), ref, name, namespace));
  const ok = await waitFor(d, "agent_ok");
  return inOwnerHub(
    (s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where namespace = ? and name = ? and live = 1",
          namespace,
          ok.bus_name,
        )
        .toArray()[0]?.id as string,
  );
}

describe("route policy", () => {
  it("lists all three routes as plain session rows (header CSRF)", () => {
    for (const k of [
      "GET /api/v1/roles",
      "PUT /api/v1/roles/:namespace/:role",
      "DELETE /api/v1/roles/:namespace/:role",
    ])
      expect(ROUTE_POLICY[k], k).toEqual({ session: expect.any(String) });
  });
});

describe("gate", () => {
  it("401 without a session, 403 without X-OB-Request, 401 for a machine token", async () => {
    const path = R.role("test.local/gate", "lane-1");
    const body = { agentId: newId() };
    const noSession = await put(path, body, {
      origin: ORIGIN,
      [CSRF_HEADER]: "1",
    });
    expect(noSession.status).toBe(401);
    expect((await error(noSession)).code).toBe("unauthorized");

    const noHeader = await put(path, body, {
      cookie: await cookie(),
      origin: ORIGIN,
    });
    expect(noHeader.status).toBe(403);
    expect((await error(noHeader)).code).toBe("csrf");

    const m = await machine("roles-bearer");
    const bearer = { authorization: `Bearer ${m.token}` };
    for (const r of [
      await put(path, body, { ...bearer, origin: ORIGIN, [CSRF_HEADER]: "1" }),
      await del(path, { ...bearer, origin: ORIGIN, [CSRF_HEADER]: "1" }),
      await SELF.fetch(`${ORIGIN}${R.roles}`, { headers: bearer }),
    ]) {
      expect(r.status).toBe(401);
      expect((await error(r)).code).toBe("unauthorized");
    }
  });
});

describe("PUT /api/v1/roles/:namespace/:role", () => {
  it("400 with the field for a bad path value or body", async () => {
    const h = await owner();
    const good = { agentId: newId() };
    for (const [path, field] of [
      ["/api/v1/roles/Bad%20NS/lane-1", "namespace"],
      ["/api/v1/roles/a%3Ab/lane-1", "namespace"],
      ["/api/v1/roles/test.local%2Fx/bad%2Frole", "role"],
      ["/api/v1/roles/test.local%2Fx/openbus", "role"],
      [`/api/v1/roles/test.local%2Fx/${"a".repeat(65)}`, "role"],
    ] as const) {
      const r = await put(path, good, h);
      expect(r.status, path).toBe(400);
      expect(await error(r), path).toMatchObject({
        code: "bad_request",
        details: { field },
      });
    }
    const path = R.role("test.local/x", "lane-1");
    for (const body of [
      "not json",
      {},
      { agentId: "nope!" },
      { agentId: newId(), extra: 1 },
    ]) {
      const r = await put(path, body, h);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await error(r)).toMatchObject({
        code: "bad_request",
        details: { field: "body" },
      });
    }
  });

  it("400 agentId for an unknown, closed or out-of-scope agent", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("bad");
      const b = ns("bad");
      await register(d, "p-a", "Alpha", a);
      const other = await register(d, "p-b", "Bravo", b);
      const closed = await register(d, "p-c", "Charlie", a);
      d.send({ v: 1, id: id("d"), type: "agent_down", agent_ref: "p-c" });
      await register(d, "p-sync", "Sync", a);
      const h = await owner();
      for (const agentId of [newId(), other, closed]) {
        const r = await put(R.role(a, "lane-1"), { agentId }, h);
        expect(r.status).toBe(400);
        expect(await error(r)).toMatchObject({
          code: "bad_request",
          details: { field: "agentId" },
        });
      }
    } finally {
      d.close();
    }
  });

  it("409 for name_taken, agent_has_role and full", async () => {
    const d = await ready((await machine()).token);
    const a = ns("conf");
    try {
      const alpha = await register(d, "c-a", "Alpha", a);
      const h = await owner();
      const taken = await put(R.role(a, "ALPHA"), { agentId: alpha }, h);
      expect(taken.status).toBe(409);
      expect((await error(taken)).code).toBe("conflict");

      expect(
        (await put(R.role(a, "lane-1"), { agentId: alpha }, h)).status,
      ).toBe(204);
      const has = await put(R.role(a, "lane-2"), { agentId: alpha }, h);
      expect(has.status).toBe(409);
      expect((await error(has)).code).toBe("conflict");

      const bravo = await register(d, "c-b", "Bravo", a);
      const filler = ns("fill");
      await inOwnerHub((s) => {
        const n = s.storage.sql
          .exec<{ n: number }>("select count(*) as n from roles")
          .one().n;
        for (let i = n; i < LIMITS.maxRoles; i++)
          s.storage.sql.exec(
            "insert into roles (org_id, namespace, role, lrole, agent_id, set_at) values (?, ?, ?, ?, null, 0)",
            OWNER_ORG_ID,
            filler,
            `r${i}`,
            `r${i}`,
          );
      });
      try {
        const full = await put(R.role(a, "lane-3"), { agentId: bravo }, h);
        expect(full.status).toBe(409);
        expect((await error(full)).code).toBe("conflict");
      } finally {
        await inOwnerHub((s) =>
          s.storage.sql.exec("delete from roles where namespace = ?", filler),
        );
      }
    } finally {
      d.close();
    }
  });

  it("204; GET lists it; DELETE 204 then 404; GET no longer lists it", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("life");
      const alpha = await register(d, "l-a", "Alpha", a);
      const h = await owner();
      const r = await put(R.role(a, "Lane 7"), { agentId: alpha }, h);
      expect(r.status).toBe(204);
      expect(await r.text()).toBe("");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect((await roles()).filter((x) => x.namespace === a)).toEqual([
        {
          namespace: a,
          role: "Lane 7",
          agentId: alpha,
          setAt: expect.any(String),
        },
      ]);

      const first = await del(R.role(a, "lane 7"), h);
      expect(first.status).toBe(204);
      expect(await first.text()).toBe("");
      const second = await del(R.role(a, "Lane 7"), h);
      expect(second.status).toBe(404);
      expect((await error(second)).code).toBe("not_found");
      expect((await roles()).some((x) => x.namespace === a)).toBe(false);
    } finally {
      d.close();
    }
  });

  it("round-trips a namespace that needs encoding through R.role", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = `${ns("enc")}/sub~dir/x.y`;
      expect(R.role(a, "lane-1")).toContain("%2F");
      const alpha = await register(d, "e-a", "Alpha", a);
      const h = await owner();
      expect(
        (await put(R.role(a, "lane-1"), { agentId: alpha }, h)).status,
      ).toBe(204);
      expect((await roles()).find((x) => x.namespace === a)).toMatchObject({
        namespace: a,
        role: "lane-1",
        agentId: alpha,
      });
      expect((await del(R.role(a, "lane-1"), h)).status).toBe(204);
    } finally {
      d.close();
    }
  });

  it("fans out roster_changed to a daemon connected during the PUT and DELETE", async () => {
    const d1 = await ready((await machine()).token);
    const d2 = await ready((await machine()).token);
    try {
      const a = ns("fan");
      const alpha = await register(d1, "f-a", "Alpha", a);
      await register(d2, "f-b", "Bravo", a);
      const h = await owner();
      // d2 caused the last change, so its first roster_changed is the PUT's.
      expect(
        (await put(R.role(a, "lane-1"), { agentId: alpha }, h)).status,
      ).toBe(204);
      expect((await waitFor(d2, "roster_changed")).namespace).toBe(a);
      expect((await del(R.role(a, "lane-1"), h)).status).toBe(204);
      expect((await waitFor(d2, "roster_changed")).namespace).toBe(a);
    } finally {
      d1.close();
      d2.close();
    }
  });
});

async function agents() {
  const r = await SELF.fetch(`${ORIGIN}${R.agents}`, {
    headers: { cookie: await cookie() },
  });
  expect(r.status).toBe(200);
  return AgentsResponseSchema.parse(await r.json()).agents;
}

/** A dashboard socket on the owner hub; every frame must be a BusEvent. */
async function dashboard() {
  const res = await (hub(e) as unknown as Fetcher).fetch(
    `https://hub.internal${EVENTS_DO_PATH}`,
    {
      headers: {
        Upgrade: "websocket",
        [SESSION_EXP_HEADER]: String(Date.now() + 6 * 24 * 3_600_000),
        [SESSION_GEN_HEADER]: "0",
      },
    },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const seen: BusEvent[] = [];
  ws.addEventListener("message", (ev) =>
    seen.push(BusEventSchema.parse(JSON.parse(String(ev.data)))),
  );
  return { ws, seen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("role on the agent DTO (Fix round 1)", () => {
  it("GET /agents shows role on the holder, and none after DELETE", async () => {
    const d = await ready((await machine()).token);
    try {
      const a = ns("dto");
      const alpha = await register(d, "t-a", "Alpha", a);
      const bravo = await register(d, "t-b", "Bravo", a);
      const h = await owner();
      expect(
        (await put(R.role(a, "Lane 1"), { agentId: alpha }, h)).status,
      ).toBe(204);
      const byId = new Map((await agents()).map((x) => [x.id, x]));
      expect(byId.get(alpha)?.role).toBe("Lane 1");
      expect(byId.get(bravo)).not.toHaveProperty("role");
      expect((await del(R.role(a, "Lane 1"), h)).status).toBe(204);
      expect((await agents()).find((x) => x.id === alpha)).not.toHaveProperty(
        "role",
      );
    } finally {
      d.close();
    }
  });

  it("a dashboard socket receives an agents frame with role after a PUT", async () => {
    const d = await ready((await machine()).token);
    const o = await dashboard();
    try {
      const a = ns("push");
      const alpha = await register(d, "s-a", "Alpha", a);
      // Past the push throttle, so the PUT's push is immediate (no alarm).
      await sleep(700);
      const h = await owner();
      expect(
        (await put(R.role(a, "lane-9"), { agentId: alpha }, h)).status,
      ).toBe(204);
      const withRole = () =>
        o.seen.some(
          (f) =>
            f.type === "agents" &&
            f.agents.some((x) => x.id === alpha && x.role === "lane-9"),
        );
      for (let i = 0; i < 100 && !withRole(); i++) await sleep(20);
      expect(withRole()).toBe(true);
    } finally {
      o.ws.close();
      d.close();
    }
  });
});
