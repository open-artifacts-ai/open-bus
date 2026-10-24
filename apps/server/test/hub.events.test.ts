import { runInDurableObject } from "cloudflare:test";
import {
  AgentSchema,
  type BusEvent,
  BusEventSchema,
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  LIMITS,
  MachineSchema,
  newId,
  OWNER_ORG_ID,
  PONG,
  type ServerFrame,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import type { Hub, HubStub } from "../src/hub/do.js";
import { agentDto, iso, machineDto } from "../src/hub/dto.js";
import { e, hello, ns, up } from "./helpers.js";

// ------------------------------------------------------------------ helpers
//
// Every test runs on its own hub (newUniqueId), so observer counts and
// rosters never leak between tests. Daemons connect through the DO's
// internal /hub forward, exactly as the Worker's /hub route does.

const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;

const fetchOf = (h: HubStub) =>
  (h as unknown as DurableObjectStub<Hub>).fetch.bind(h);

const inHub = <R>(h: HubStub, fn: (i: Hub, s: DurableObjectState) => R) =>
  runInDurableObject(h as unknown as DurableObjectStub<Hub>, (i: Hub, s) =>
    fn(i, s),
  );

const tick = () => new Promise((r) => setTimeout(r, 20));

type Obs = {
  ws: WebSocket;
  events: BusEvent[];
  next: () => Promise<BusEvent>;
  /** Frames received and not yet consumed by next(). */
  pending: () => number;
  closed: Promise<{ code: number; reason: string }>;
  isClosed: () => boolean;
};

/** Wires a client socket; `parse` turns each text frame into T or throws. */
function wire<T>(ws: WebSocket, parse: (t: string) => T | null) {
  ws.accept();
  const queue: T[] = [];
  const waiting: ((f: T) => void)[] = [];
  const seen: T[] = [];
  let done = false;
  ws.addEventListener("message", (ev) => {
    const f = parse(String(ev.data));
    if (f === null) return;
    seen.push(f);
    const w = waiting.shift();
    if (w) w(f);
    else queue.push(f);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => {
      done = true;
      resolve({ code: ev.code, reason: ev.reason });
    }),
  );
  const next = () => {
    const f = queue.shift();
    if (f !== undefined) return Promise.resolve(f);
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 3000);
      waiting.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  };
  return {
    seen,
    next,
    pending: () => queue.length,
    closed,
    isClosed: () => done,
  };
}

/** An observer on `h`. Every frame must parse with BusEventSchema. */
async function observer(h: HubStub): Promise<Obs> {
  const res = await fetchOf(h)("https://hub.internal/events", {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  const w = wire<BusEvent>(ws, (t) => {
    const r = BusEventSchema.safeParse(JSON.parse(t));
    expect(r.success, `not a BusEvent: ${t}`).toBe(true);
    return r.success ? r.data : null;
  });
  return { ws, events: w.seen, ...w };
}

/** Reads past the snapshot (hello, machines, agents). */
async function snapshot(o: Obs) {
  const a = await o.next();
  const b = await o.next();
  const c = await o.next();
  return [a, b, c] as const;
}

/** One push: a full machines frame, then a full agents frame. */
async function push(o: Obs) {
  const m = await o.next();
  const a = await o.next();
  if (m.type !== "machines" || a.type !== "agents")
    throw new Error(`not a push: ${m.type}, ${a.type}`);
  return { machines: m.machines, agents: a.agents };
}

type D = {
  ws: WebSocket;
  next: () => Promise<ServerFrame>;
  send: (f: ClientFrame) => void;
};

async function daemonOn(h: HubStub, machineId: string): Promise<D> {
  const res = await fetchOf(h)("https://hub.internal/hub", {
    headers: { Upgrade: "websocket", "X-Ob-Machine-Id": machineId },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  const w = wire<ServerFrame>(ws, (t) => {
    if (t === PONG) return null;
    const r = decodeServerFrame(t);
    expect(r.ok, `not a server frame: ${t}`).toBe(true);
    return r.ok ? r.frame : null;
  });
  return { ws, next: w.next, send: (f) => ws.send(encodeFrame(f)) };
}

async function until<T extends ServerFrame["type"]>(d: D, type: T) {
  for (let i = 0; i < 5000; i++) {
    const f = await d.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type}`);
}

/** Round-trips a hello: every frame sent before it has been handled. */
async function sync(d: D) {
  d.send(hello("sync"));
  await until(d, "hello_ok");
}

async function machineOn(h: HubStub, label = "MacBook") {
  const m = await h.createMachine(label);
  if (!m.ok) throw new Error(m.code);
  return m.id;
}

/**
 * Creates a machine as a marker, then drains the observer up to and including
 * the push that lists it. Returns how many pushes arrived before the marker's.
 */
async function pushesBefore(h: HubStub, o: Obs): Promise<number> {
  const label = `marker-${newId()}`;
  await machineOn(h, label);
  for (let n = 0; n < 1000; n++) {
    const p = await push(o);
    if (p.machines.some((m) => m.label === label)) return n;
  }
  throw new Error("marker never pushed");
}

/** Seeds an agent row directly (for listAgents filters, order and cap). */
function seedAgent(
  s: DurableObjectState,
  a: {
    machineId: string;
    namespace: string;
    name: string;
    global?: boolean;
    live?: boolean;
  },
) {
  s.storage.sql.exec(
    `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
     values (?, ?, ?, ?, 'opencode', ?, ?, ?, ?, ?)`,
    newId(),
    OWNER_ORG_ID,
    a.namespace,
    a.name,
    a.machineId,
    `ref-${newId()}`,
    a.global ? 1 : 0,
    a.live === false ? 0 : 1,
    1_800_000_000_000,
  );
}

const revoke = (h: HubStub, id: string) =>
  inHub(h, (_, s) => {
    s.storage.sql.exec(
      "update machines set revoked_at = ? where id = ?",
      Date.now(),
      id,
    );
  });

// -------------------------------------------------------------------- DTOs

describe("dashboard DTOs", () => {
  it("machineDto and agentDto parse with the strict shared schemas", () => {
    const m = machineDto({
      id: newId(),
      label: "MacBook",
      createdAt: 1_800_000_000_000,
      lastUsedAt: null,
      revokedAt: null,
      connected: true,
    });
    expect(MachineSchema.parse(m)).toEqual(m);
    const r = machineDto({
      id: newId(),
      label: "Old",
      createdAt: 1_800_000_000_000,
      lastUsedAt: 1_800_000_001_000,
      revokedAt: 1_800_000_002_000,
      connected: true,
    });
    expect(r.connected).toBe(false);
    expect(MachineSchema.parse(r)).toEqual(r);
    const a = agentDto(
      {
        id: newId(),
        namespace: "test.local/x",
        name: "alice",
        lastName: null,
        kind: "claude-code",
        machineId: newId(),
        nativeRef: "ref-1",
        global: 1,
        live: 1,
        updatedAt: 1_800_000_000_000,
        machineLabel: "MacBook",
      },
      false,
    );
    expect(a.state).toBe("queued");
    expect(a.global).toBe(true);
    expect(AgentSchema.parse(a)).toEqual(a);
    expect(iso(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(iso(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- listAgents

describe("listAgents", () => {
  it("live while the machine is connected, queued otherwise; closed omitted", async () => {
    const h = freshHub();
    const mid = await machineOn(h, "Desk");
    const n = ns("state");
    const d = await daemonOn(h, mid);
    d.send(up("u1", "r1", "alice", n));
    await until(d, "agent_ok");
    d.send(up("u2", "r2", "bob", n));
    await until(d, "agent_ok");
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "r2" });
    await sync(d);
    let agents = await h.listAgents(n);
    for (const a of agents) AgentSchema.parse(a);
    expect(agents.map((a) => [a.name, a.state, a.machineLabel])).toEqual([
      ["alice", "live", "Desk"],
    ]);
    d.ws.close(1000, "bye");
    await tick();
    agents = await h.listAgents(n);
    expect(agents.map((a) => [a.name, a.state])).toEqual([["alice", "queued"]]);
  });

  it("omits agents of revoked machines", async () => {
    const h = freshHub();
    const keep = await machineOn(h, "Keep");
    const gone = await machineOn(h, "Gone");
    const n = ns("rev");
    await inHub(h, (_, s) => {
      seedAgent(s, { machineId: keep, namespace: n, name: "kept" });
      seedAgent(s, { machineId: gone, namespace: n, name: "lost" });
    });
    await revoke(h, gone);
    expect((await h.listAgents()).map((a) => a.name)).toEqual(["kept"]);
    expect((await h.listAgents(n)).map((a) => a.name)).toEqual(["kept"]);
  });

  it("filters by namespace plus every global, ordered by namespace then name (case-insensitive)", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    await inHub(h, (_, s) => {
      seedAgent(s, { machineId: mid, namespace: "ns-b", name: "carol" });
      seedAgent(s, { machineId: mid, namespace: "ns-b", name: "Bob" });
      seedAgent(s, { machineId: mid, namespace: "ns-b", name: "alice" });
      seedAgent(s, { machineId: mid, namespace: "ns-c", name: "other" });
      seedAgent(s, {
        machineId: mid,
        namespace: "ns-a",
        name: "Zed",
        global: true,
      });
      seedAgent(s, {
        machineId: mid,
        namespace: "ns-z",
        name: "amy",
        global: true,
      });
      seedAgent(s, {
        machineId: mid,
        namespace: "ns-b",
        name: "closed",
        live: false,
      });
    });
    const inB = await h.listAgents("ns-b");
    expect(inB.map((a) => `${a.namespace}:${a.name}`)).toEqual([
      "ns-a:Zed",
      "ns-b:alice",
      "ns-b:Bob",
      "ns-b:carol",
      "ns-z:amy",
    ]);
    const all = await h.listAgents();
    expect(all.map((a) => `${a.namespace}:${a.name}`)).toEqual([
      "ns-a:Zed",
      "ns-b:alice",
      "ns-b:Bob",
      "ns-b:carol",
      "ns-c:other",
      "ns-z:amy",
    ]);
    for (const a of all) AgentSchema.parse(a);
  });

  it("an invalid namespace returns [] and never throws", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    await inHub(h, (_, s) =>
      seedAgent(s, {
        machineId: mid,
        namespace: "ns-a",
        name: "g",
        global: true,
      }),
    );
    for (const bad of [
      "",
      "Bad NS",
      "UPPER",
      "x".repeat(LIMITS.maxNamespaceChars + 1),
      42,
      null,
      { namespace: "ns-a" },
    ])
      expect(await h.listAgents(bad as unknown as string)).toEqual([]);
    expect((await h.listAgents(undefined)).length).toBe(1);
  });

  it("caps the result at maxRosterAgents", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    await inHub(h, (_, s) => {
      for (let k = 0; k <= LIMITS.maxRosterAgents; k++)
        seedAgent(s, {
          machineId: mid,
          namespace: "ns-cap",
          name: `a-${String(k).padStart(4, "0")}`,
        });
    });
    const all = await h.listAgents();
    expect(all.length).toBe(LIMITS.maxRosterAgents);
    expect(all[0]?.name).toBe("a-0000");
    expect((await h.listAgents("ns-cap")).length).toBe(LIMITS.maxRosterAgents);
  });

  it("uses indexes, never a full scan of agents", async () => {
    const h = freshHub();
    const plans = await inHub(h, (_, s) =>
      [
        "select a.id from agents a join machines m on m.id = a.machine_id where a.org_id = ? and a.live = 1 and m.revoked_at is null order by a.namespace, lower(a.name), a.name limit 10",
        "select a.id from agents a join machines m on m.id = a.machine_id where a.org_id = ? and a.namespace = ? and a.live = 1 and m.revoked_at is null order by lower(a.name), a.name limit 10",
        "select a.id from agents a indexed by agents_global_name join machines m on m.id = a.machine_id where a.org_id = ? and a.live = 1 and a.global = 1 and m.revoked_at is null order by a.namespace, lower(a.name), a.name limit 10",
      ].map((q) =>
        s.storage.sql
          .exec<{ detail: string }>(
            `explain query plan ${q}`,
            ...(q.includes("namespace = ?") ? ["o", "n"] : ["o"]),
          )
          .toArray()
          .map((r) => r.detail)
          .join(" | "),
      ),
    );
    for (const p of plans) {
      // agents through an index, machines by primary key: never a table scan.
      expect(p).not.toMatch(/SCAN a(?! USING)/);
      expect(p).not.toMatch(/SCAN m\b/);
    }
    expect(plans[0]).toMatch(/USING INDEX agents_live_ns_lname/);
    expect(plans[1]).toMatch(/USING INDEX agents_live_ns_lname/);
    expect(plans[2]).toMatch(/USING INDEX agents_global_name/);
  });
});

// ---------------------------------------------------------- observer socket

describe("observer socket", () => {
  it("answers 426 without an upgrade", async () => {
    const h = freshHub();
    const r = await fetchOf(h)("https://hub.internal/events");
    expect(r.status).toBe(426);
  });

  it("sends hello, machines, agents on connect, matching listMachines", async () => {
    const h = freshHub();
    const a = await machineOn(h, "Alpha");
    const b = await machineOn(h, "Beta");
    await revoke(h, a);
    const n = ns("snap");
    await inHub(h, (_, s) =>
      seedAgent(s, { machineId: b, namespace: n, name: "solo" }),
    );
    const o = await observer(h);
    const [first, second, third] = await snapshot(o);
    expect(first).toEqual({ type: "hello" });
    expect(second.type).toBe("machines");
    expect(third.type).toBe("agents");
    const expected = (await h.listMachines()).map(machineDto);
    if (second.type !== "machines") throw new Error();
    expect(second.machines).toEqual(expected);
    expect(second.machines.map((m) => m.label)).toEqual(["Beta", "Alpha"]);
    if (third.type !== "agents") throw new Error();
    expect(third.agents.map((x) => [x.name, x.state])).toEqual([
      ["solo", "queued"],
    ]);
    o.ws.close();
  });

  it("pushes on daemon connect and disconnect", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("conn");
    await inHub(h, (_, s) =>
      seedAgent(s, { machineId: mid, namespace: n, name: "a1" }),
    );
    const o = await observer(h);
    await snapshot(o);
    const d = await daemonOn(h, mid);
    let p = await push(o);
    expect(p.machines.find((m) => m.id === mid)?.connected).toBe(true);
    expect(p.agents.map((x) => x.state)).toEqual(["live"]);
    d.ws.close(1000, "bye");
    p = await push(o);
    expect(p.machines.find((m) => m.id === mid)?.connected).toBe(false);
    expect(p.agents.map((x) => x.state)).toEqual(["queued"]);
    o.ws.close();
  });

  it("pushes on agent_up, agent_down, sessions{closed} and createMachine", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("chg");
    const d = await daemonOn(h, mid);
    const o = await observer(h);
    await snapshot(o);

    d.send(up("u1", "r1", "alice", n));
    let p = await push(o);
    expect(p.agents.map((x) => x.name)).toEqual(["alice"]);

    d.send(up("u2", "r2", "bob", n));
    p = await push(o);
    expect(p.agents.map((x) => x.name)).toEqual(["alice", "bob"]);

    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "r1" });
    p = await push(o);
    expect(p.agents.map((x) => x.name)).toEqual(["bob"]);

    d.send({ v: 1, id: "ss", type: "sessions", open: [], closed: ["r2"] });
    p = await push(o);
    expect(p.agents).toEqual([]);

    await machineOn(h, "Second");
    p = await push(o);
    expect(p.machines.map((m) => m.label)).toContain("Second");
    o.ws.close();
  });

  it("coalesces: sessions{closed} with 50 refs is one push", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("burst");
    const d = await daemonOn(h, mid);
    const refs: string[] = [];
    for (let k = 0; k < 50; k++) {
      refs.push(`r${k}`);
      d.send(up(`u${k}`, `r${k}`, `agent-${k}`, n));
    }
    await sync(d);
    const o = await observer(h);
    const [, , agents] = await snapshot(o);
    if (agents.type !== "agents") throw new Error();
    expect(agents.agents.length).toBe(50);
    d.send({ v: 1, id: "ss", type: "sessions", open: [], closed: refs });
    await sync(d);
    // The sessions push, then the marker's own push.
    expect(await pushesBefore(h, o)).toBe(1);
    expect(await h.listAgents()).toEqual([]);
    o.ws.close();
  });

  it("runs no observer queries while no observer is connected", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    // Counts the observer feed's queries (listMachines and the agents join).
    const count = (fn: (i: Hub) => Promise<unknown>) =>
      inHub(h, async (i, s) => {
        const sql = s.storage.sql;
        const orig = sql.exec.bind(sql);
        let n = 0;
        (sql as { exec: unknown }).exec = (q: string, ...b: unknown[]) => {
          if (/join machines m|order by \(revoked_at is null\)/.test(q)) n++;
          return orig(q, ...(b as SqlStorageValue[]));
        };
        try {
          await fn(i);
          await tick();
        } finally {
          (sql as { exec: unknown }).exec = orig;
        }
        return n;
      });
    expect(await count((i) => i.createMachine("NoObs"))).toBe(0);
    const o = await observer(h);
    await snapshot(o);
    expect(await count((i) => i.createMachine("WithObs"))).toBeGreaterThan(0);
    o.ws.close();
    await o.closed;
    await tick();
    expect(await count((i) => i.createMachine("AfterObs"))).toBe(0);
    expect(mid).toBeTruthy();
  });

  it("ignores frames an observer sends; an observer never counts as connected", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const o = await observer(h);
    await snapshot(o);
    o.ws.send("garbage");
    o.ws.send(encodeFrame(hello()));
    o.ws.send(
      encodeFrame({
        v: 1,
        id: "u",
        type: "agent_up",
        agent_ref: "x",
        kind: "opencode",
        proposed_name: "spy",
        namespace: "ns-spy",
        global: false,
      }),
    );
    o.ws.send(new Uint8Array([1, 2, 3]));
    await tick();
    // Nothing came back: the next push is the marker's own.
    expect(await pushesBefore(h, o)).toBe(0);
    expect(o.isClosed()).toBe(false);
    const ms = await h.listMachines();
    expect(ms.find((m) => m.id === mid)?.connected).toBe(false);
    expect(await h.listAgents()).toEqual([]);
    o.ws.close();
  });

  it("an observer closing runs no daemon bookkeeping", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("oc");
    const d = await daemonOn(h, mid);
    d.send(up("u1", "r1", "alice", n));
    await until(d, "agent_ok");
    const watcher = await observer(h);
    await snapshot(watcher);
    const o = await observer(h);
    await snapshot(o);
    o.ws.close(1000, "bye");
    await o.closed;
    await tick();
    // No push from the observer's close: the next one is the marker's.
    expect(await pushesBefore(h, watcher)).toBe(0);
    expect((await h.listMachines()).find((m) => m.id === mid)?.connected).toBe(
      true,
    );
    expect((await h.listAgents()).map((a) => a.state)).toEqual(["live"]);
    // The daemon still works.
    await sync(d);
    watcher.ws.close();
  });

  it("caps observers at 16: the 17th evicts the oldest with 1013", async () => {
    const h = freshHub();
    const obs: Obs[] = [];
    for (let k = 0; k < 16; k++) {
      const o = await observer(h);
      await snapshot(o);
      obs.push(o);
    }
    const extra = await observer(h);
    await snapshot(extra);
    expect((await obs[0]?.closed)?.code).toBe(1013);
    await tick();
    for (const o of obs.slice(1)) expect(o.isClosed()).toBe(false);
    // The evicted one may still be listed while its close completes.
    expect(
      await inHub(
        h,
        (_, s) =>
          s.getWebSockets("observer").filter((w) => w.readyState === 1).length,
      ),
    ).toBe(16);
    for (const o of [...obs.slice(1), extra]) o.ws.close();
  });

  it("at the cap, a non-open observer is closed first and the oldest open one kept", async () => {
    const h = freshHub();
    const obs: Obs[] = [];
    for (let k = 0; k < 16; k++) {
      const o = await observer(h);
      await snapshot(o);
      obs.push(o);
    }
    // Inside the hub: one observer goes non-open, then a 17th connects in
    // the same turn, before the close completes.
    const res = await inHub(h, async (i, s) => {
      // Not the oldest (attachment seq is the connect order).
      const target = s
        .getWebSockets("observer")
        .sort(
          (x, y) =>
            (x.deserializeAttachment() as { seq: number }).seq -
            (y.deserializeAttachment() as { seq: number }).seq,
        )[5];
      target?.close(1000, "going");
      const state = target?.readyState;
      const r = await i.fetch(
        new Request("https://hub.internal/events", {
          headers: { Upgrade: "websocket" },
        }),
      );
      r.webSocket?.accept();
      return { status: r.status, state };
    });
    expect(res.status).toBe(101);
    expect(res.state).not.toBe(WebSocket.OPEN);
    await tick();
    expect(obs[0]?.isClosed()).toBe(false);
    expect(obs.filter((o) => o.isClosed()).length).toBe(1);
    for (const o of obs) if (!o.isClosed()) o.ws.close();
  });

  it("closes an observer with 1011 when a send to it throws", async () => {
    const h = freshHub();
    const bad = await observer(h);
    await snapshot(bad);
    const good = await observer(h);
    await snapshot(good);
    await inHub(h, (_, s) => {
      // The oldest (attachment seq is the connect order) is `bad`.
      const first = s
        .getWebSockets("observer")
        .sort(
          (x, y) =>
            (x.deserializeAttachment() as { seq: number }).seq -
            (y.deserializeAttachment() as { seq: number }).seq,
        )[0] as WebSocket;
      first.send = () => {
        throw new Error("dead");
      };
    });
    await machineOn(h, "Trigger");
    expect((await bad.closed).code).toBe(1011);
    const p = await push(good);
    expect(p.machines.map((m) => m.label)).toContain("Trigger");
    good.ws.close();
  });
});
