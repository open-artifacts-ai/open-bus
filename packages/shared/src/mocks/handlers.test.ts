import { ws } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorSchema } from "../errors.js";
import { LIMITS } from "../limits.js";
import {
  AgentSchema,
  AgentsResponseSchema,
  type BusEvent,
  BusEventSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  MachineSchema,
  MachinesResponseSchema,
  MeSchema,
} from "../rest.js";
import { agents, machines, me } from "./fixtures.js";
import {
  broadcast,
  closeAll,
  createWsHandler,
  eventsHandler,
  eventsLink,
  eventsWsHandler,
  handlers,
  resetMocks,
} from "./handlers.js";

const B = "https://bus.test";
const WSB = "wss://bus.test";
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing fixture");
  return v;
};
const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetMocks();
});
afterAll(() => server.close());

const del = (id: string, csrf = true) =>
  fetch(`${B}/api/v1/machines/${id}`, {
    method: "DELETE",
    headers: csrf ? { [CSRF_HEADER]: CSRF_VALUE } : {},
  });
const list = async () =>
  MachinesResponseSchema.parse(
    await (await fetch(`${B}/api/v1/machines`)).json(),
  ).machines;

describe("machine list order", () => {
  it("lists active machines first, then revoked, each newest first", async () => {
    const newest = [...machines]
      .filter((m) => !m.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    expect((await del(must(newest).id)).status).toBe(204);
    const out = await list();
    const firstRevoked = out.findIndex((m) => m.revokedAt);
    expect(out.slice(firstRevoked).every((m) => m.revokedAt)).toBe(true);
    expect(out.slice(0, firstRevoked).every((m) => !m.revokedAt)).toBe(true);
    for (const grp of [out.slice(0, firstRevoked), out.slice(firstRevoked)])
      expect(grp.map((m) => m.createdAt)).toEqual(
        [...grp.map((m) => m.createdAt)].sort().reverse(),
      );
  });
});

describe("fixtures", () => {
  it("parse with the contract schemas", () => {
    for (const m of machines) MachineSchema.parse(m);
    for (const a of agents) AgentSchema.parse(a);
    MeSchema.parse(me);
  });
  it("machines cover connected and disconnected; revoked is never connected", () => {
    expect(machines.some((m) => m.connected)).toBe(true);
    expect(machines.some((m) => !m.connected)).toBe(true);
    for (const m of machines) if (m.revokedAt) expect(m.connected).toBe(false);
  });
  it("cover live, queued and revoked", () => {
    expect(agents.some((a) => a.state === "live")).toBe(true);
    expect(agents.some((a) => a.state === "queued")).toBe(true);
    expect(machines.some((m) => m.revokedAt !== null)).toBe(true);
    expect(machines.some((m) => m.revokedAt === null)).toBe(true);
  });
});

describe("handlers", () => {
  it("serves me", async () => {
    const r = MeSchema.parse(await (await fetch(`${B}/api/v1/me`)).json());
    expect(r.user.email).toContain("@");
  });

  it("lists active and revoked machines, newest first, within the cap", async () => {
    const ms = await list();
    expect(ms).toHaveLength(machines.length);
    expect(ms.length).toBeLessThanOrEqual(LIMITS.maxMachinesListed);
    expect(ms.some((m) => m.revokedAt)).toBe(true);
    const created = ms.map((m) => m.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it("filters agents by namespace, keeping global ones", async () => {
    const ns = must(agents.find((a) => !a.global)).namespace;
    const r = AgentsResponseSchema.parse(
      await (
        await fetch(`${B}/api/v1/agents?namespace=${encodeURIComponent(ns)}`)
      ).json(),
    );
    expect(r.agents.length).toBeGreaterThan(0);
    expect(r.agents.every((a) => a.namespace === ns || a.global)).toBe(true);
    const all = AgentsResponseSchema.parse(
      await (await fetch(`${B}/api/v1/agents`)).json(),
    );
    expect(all.agents).toHaveLength(agents.length);
  });

  it("revokes once (204), keeps the row listed, then 404s", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    expect((await del(id)).status).toBe(204);
    const after = (await list()).find((m) => m.id === id);
    expect(after?.revokedAt).not.toBeNull();
    expect(after?.connected).toBe(false);
    const again = await del(id);
    expect(again.status).toBe(404);
    ApiErrorSchema.parse(await again.json());
  });

  it("404s an unknown or already-revoked machine with a valid envelope", async () => {
    for (const id of [
      must(machines.find((m) => m.revokedAt)).id,
      "zzzzzzzzzzzzzzzz",
    ]) {
      const r = await del(id);
      expect(r.status).toBe(404);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("not_found");
    }
  });

  it("403s DELETE without the CSRF header and does not revoke", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    const r = await del(id, false);
    expect(r.status).toBe(403);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("csrf");
    expect((await list()).find((m) => m.id === id)?.revokedAt).toBeNull();
  });

  it("drops a revoked machine's agents from GET /agents and the next feed snapshot", async () => {
    const id = must(agents.find((a) => a.state === "live")).machineId;
    const owned = agents.filter((a) => a.machineId === id).length;
    expect(owned).toBeGreaterThan(0);
    await del(id);
    const r = AgentsResponseSchema.parse(
      await (await fetch(`${B}/api/v1/agents`)).json(),
    );
    expect(r.agents.some((a) => a.machineId === id)).toBe(false);
    expect(r.agents).toHaveLength(agents.length - owned);
    expect((await list()).find((m) => m.id === id)?.revokedAt).not.toBeNull();
    const c = await connect();
    const raw = (await c.take(3)).join("\n");
    expect(raw).not.toContain(`"machineId":"${id}"`);
    c.ws.close();
    resetMocks();
    const back = AgentsResponseSchema.parse(
      await (await fetch(`${B}/api/v1/agents`)).json(),
    );
    expect(back.agents).toHaveLength(agents.length);
  });

  it("resetMocks undoes mutations between tests", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    await del(id);
    resetMocks();
    expect((await list()).find((m) => m.id === id)?.revokedAt).toBeNull();
    expect((await del(id)).status).toBe(204);
  });
});

// ------------------------------------------------------- WebSocket feed (B10-ws)

type Client = {
  ws: WebSocket;
  /** The next `n` text frames (raw), waiting for them. */
  take: (n: number) => Promise<string[]>;
  pending: () => number;
  closed: Promise<{ code: number; reason: string }>;
};

/** Opens the feed through msw's ws interception (Node's global WebSocket). */
function connect(url = `${WSB}/api/v1/events`): Promise<Client> {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  const waiting: (() => void)[] = [];
  ws.addEventListener("message", (ev) => {
    queue.push(String(ev.data));
    for (const w of waiting.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) =>
      resolve({ code: ev.code, reason: ev.reason }),
    ),
  );
  const take = async (n: number) => {
    const deadline = Date.now() + 3000;
    while (queue.length < n) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise<void>((r) => {
        waiting.push(r);
        setTimeout(r, 50);
      });
    }
    return queue.splice(0, n);
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () =>
      resolve({ ws, take, pending: () => queue.length, closed }),
    );
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("events WebSocket mock", () => {
  it("sends hello, machines, agents in order; every frame is a BusEvent", async () => {
    const c = await connect();
    const frames = (await c.take(3)).map((t) =>
      BusEventSchema.parse(JSON.parse(t)),
    );
    expect(frames.map((f) => f.type)).toEqual(["hello", "machines", "agents"]);
    const ms = frames[1];
    if (ms?.type !== "machines") throw new Error();
    expect(ms.machines.some((m) => m.revokedAt)).toBe(true);
    const as = frames[2];
    if (as?.type !== "agents") throw new Error();
    expect(as.agents).toHaveLength(agents.length);
    await settle();
    expect(c.pending()).toBe(0);
    c.ws.close();
  });

  it("matches any origin (the link is */api/v1/events)", async () => {
    const c = await connect("ws://localhost:5173/api/v1/events");
    expect((await c.take(3)).length).toBe(3);
    c.ws.close();
  });

  it('answers "ping" with "pong" and ignores every other client frame', async () => {
    const c = await connect();
    await c.take(3);
    c.ws.send("ping");
    expect(await c.take(1)).toEqual(["pong"]);
    c.ws.send("garbage");
    c.ws.send(JSON.stringify({ type: "hello" }));
    await settle();
    expect(c.pending()).toBe(0);
    c.ws.close();
  });

  it("broadcast pushes one frame to every connected client", async () => {
    const a = await connect();
    const b = await connect();
    await a.take(3);
    await b.take(3);
    const ev: BusEvent = { type: "machines", machines: [] };
    broadcast(ev);
    for (const c of [a, b]) {
      const [t] = await c.take(1);
      expect(BusEventSchema.parse(JSON.parse(must(t)))).toEqual(ev);
    }
    a.ws.close();
    b.ws.close();
  });

  it("closeAll(4401) ends every client with that code", async () => {
    const a = await connect();
    const b = await connect();
    await a.take(3);
    await b.take(3);
    closeAll(LIMITS.dashboardSessionClose);
    expect((await a.closed).code).toBe(4401);
    expect((await b.closed).code).toBe(4401);
  });

  it("a caller-supplied link carries the same frames, broadcast and close", async () => {
    const link = ws.link("*/api/v1/custom-events");
    server.use(eventsHandler(link));
    const c = await connect(`${WSB}/api/v1/custom-events`);
    const types = (await c.take(3)).map(
      (t) => BusEventSchema.parse(JSON.parse(t)).type,
    );
    expect(types).toEqual(["hello", "machines", "agents"]);
    broadcast({ type: "hello" }, link);
    expect(await c.take(1)).toEqual([JSON.stringify({ type: "hello" })]);
    closeAll(4403, link);
    expect((await c.closed).code).toBe(4403);
  });

  it("the greeting reads current state on each connect (REST and WS agree)", async () => {
    const parse = async (c: Client) =>
      (await c.take(3)).map((t) => BusEventSchema.parse(JSON.parse(t)));
    const id = must(agents.find((a) => a.state === "live")).machineId;
    const before = await connect();
    const [, m0, a0] = await parse(before);
    if (m0?.type !== "machines" || a0?.type !== "agents") throw new Error();
    expect(m0.machines.find((m) => m.id === id)?.revokedAt).toBeNull();
    expect(a0.agents.some((a) => a.machineId === id)).toBe(true);
    before.ws.close();
    expect((await del(id)).status).toBe(204);
    const after = await connect();
    const [, m1, a1] = await parse(after);
    if (m1?.type !== "machines" || a1?.type !== "agents") throw new Error();
    expect(m1.machines).toEqual(await list());
    expect(m1.machines.find((m) => m.id === id)?.revokedAt).not.toBeNull();
    expect(a1.agents.some((a) => a.machineId === id)).toBe(false);
    const rest = AgentsResponseSchema.parse(
      await (await fetch(`${B}/api/v1/agents`)).json(),
    );
    expect(a1.agents).toEqual(rest.agents);
    after.ws.close();
  });

  it("createWsHandler calls caller providers on every connection", async () => {
    const link = ws.link("*/api/v1/provided-events");
    let ms = [must(machines[0])];
    let calls = 0;
    server.use(
      createWsHandler(
        {
          machines: () => {
            calls++;
            return ms;
          },
          agents: () => [],
        },
        link,
      ),
    );
    const url = `${WSB}/api/v1/provided-events`;
    const a = await connect(url);
    const fa = (await a.take(3)).map((t) =>
      BusEventSchema.parse(JSON.parse(t)),
    );
    expect(fa[1]).toEqual({ type: "machines", machines: ms });
    expect(fa[2]).toEqual({ type: "agents", agents: [] });
    a.ws.close();
    ms = [must(machines[1])];
    const b = await connect(url);
    const fb = (await b.take(3)).map((t) =>
      BusEventSchema.parse(JSON.parse(t)),
    );
    expect(fb[1]).toEqual({ type: "machines", machines: ms });
    expect(calls).toBe(2);
    b.ws.close();
  });

  it("exports the default link on */api/v1/events", () => {
    expect(eventsLink.clients).toBeInstanceOf(Set);
    expect(handlers).toContain(eventsWsHandler);
  });
});
