import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  AgentSchema,
  type BusEvent,
  BusEventSchema,
  type ClientFrame,
  decodeServerFrame,
  EVENTS_DO_PATH,
  encodeFrame,
  LIMITS,
  MachineSchema,
  newId,
  OWNER_ORG_ID,
  PING,
  PONG,
  SESSION_EXP_HEADER,
  SESSION_GEN_HEADER,
  type ServerFrame,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { MAX_AGE_S } from "../src/auth/max-age.js";
import { FRAME_BUDGET, Hub, type HubStub } from "../src/hub/do.js";
import { agentDto, iso, machineDto } from "../src/hub/dto.js";
import { e, hello, ns, up } from "./helpers.js";

/** The furthest x-ob-session-exp the hub accepts: B1's max age plus 1 min skew. */
const EXP_CAP_MS = MAX_AGE_S * 1000 + 60_000;

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

/** Waits for one frame this long: generous, so a loaded machine cannot flake it. */
const NEXT_TIMEOUT_MS = 15_000;
/** A session expiry far past every test clock (frozen clocks sit up to 1 h ahead). */
const farExp = () => Date.now() + 6 * 24 * HOUR;
const HOUR = 3_600_000;
const EVENTS_URL = `https://hub.internal${EVENTS_DO_PATH}`;
/** The upgrade the Worker forwards: Upgrade, the session expiry and generation. */
const dashHeaders = (
  exp: number | string = farExp(),
  gen: number | string = 0,
) => ({
  Upgrade: "websocket",
  [SESSION_EXP_HEADER]: String(exp),
  [SESSION_GEN_HEADER]: String(gen),
});

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
      const t = setTimeout(
        () => reject(new Error("timed out")),
        NEXT_TIMEOUT_MS,
      );
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

/** A dashboard socket on `h`. Every frame must parse with BusEventSchema. */
async function observer(h: HubStub, exp?: number): Promise<Obs> {
  const res = await fetchOf(h)(EVENTS_URL, { headers: dashHeaders(exp) });
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
    const r = await fetchOf(h)(EVENTS_URL);
    expect(r.status).toBe(426);
    const r2 = await fetchOf(h)(EVENTS_URL, {
      headers: { [SESSION_EXP_HEADER]: String(farExp()) },
    });
    expect(r2.status).toBe(426);
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
    // 50 frames fill the frame budget (B11): the sync starts a fresh window.
    await new Promise((r) => setTimeout(r, FRAME_BUDGET.windowMs + 50));
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
          s.getWebSockets("dashboard").filter((w) => w.readyState === 1).length,
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
        .getWebSockets("dashboard")
        .sort(
          (x, y) =>
            (x.deserializeAttachment() as { seq: number }).seq -
            (y.deserializeAttachment() as { seq: number }).seq,
        )[5];
      target?.close(1000, "going");
      const state = target?.readyState;
      const r = await i.fetch(
        new Request(EVENTS_URL, { headers: dashHeaders() }),
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
        .getWebSockets("dashboard")
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

// ------------------------------------------------ fix round 1 (adv-B10 M1, L1-L3)

/** Freezes the hub clock (Hub.setTestClock) so a throttle window cannot lapse. */
const clock = (h: HubStub, ms: number | null) =>
  inHub(h, (i) => Hub.setTestClock(i, ms));

/** Raw text frames from an observer, so an invalid frame is seen, not thrown. */
async function rawObserver(h: HubStub, exp?: number) {
  const res = await fetchOf(h)(EVENTS_URL, { headers: dashHeaders(exp) });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  return { ws, ...wire<string>(ws, (t) => t) };
}

describe("observer pushes: only on change, throttled", () => {
  it("P4: an unchanged re-up pushes nothing", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("amp");
    const d = await daemonOn(h, mid);
    d.send(up("u0", "r1", "alice", n));
    await until(d, "agent_ok");
    const o = await observer(h);
    await snapshot(o);
    for (let k = 1; k <= 20; k++) d.send(up(`u${k}`, "r1", "alice", n));
    await sync(d);
    expect(await pushesBefore(h, o)).toBe(0);
    o.ws.close();
    d.ws.close();
  });

  it("P4b: a renamed reserved-name up pushes once; its repeat and a rejected up push nothing", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("ref");
    const d = await daemonOn(h, mid);
    const o = await observer(h);
    await snapshot(o);
    d.send(up("u1", "r1", "openbus", n));
    const ok = await until(d, "agent_ok");
    await sync(d);
    const p = await push(o);
    expect(p.agents.map((a) => a.name)).toEqual([ok.bus_name]);
    d.send(up("u2", "r1", "openbus", n));
    // Rejected at decode (non-canonical namespace): never reaches the roster.
    d.ws.send(
      JSON.stringify({ ...up("u3", "r2", "bob", n), namespace: "Not OK" }),
    );
    await sync(d);
    expect(await pushesBefore(h, o)).toBe(0);
    o.ws.close();
    d.ws.close();
  });

  it("20 changing ups within 500 ms give at most 2 pushes, the last with the final state", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("thr");
    const d = await daemonOn(h, mid);
    const o = await observer(h);
    await snapshot(o);
    // An hour ahead of wall time: the real alarm (armed for t0 + 500) never
    // fires on its own, so only runDurableObjectAlarm below can run it.
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    for (let k = 0; k < 20; k++) d.send(up(`u${k}`, `r${k}`, `agent-${k}`, n));
    await sync(d);
    // The first push goes out at once; the rest wait for the trailing alarm.
    const first = await push(o);
    expect(first.agents.length).toBeLessThan(20);
    await tick();
    expect(o.pending()).toBe(0);
    // The due time is persisted, so an eviction cannot lose the push.
    const due = await inHub(h, async (_, s) => ({
      alarm: await s.storage.getAlarm(),
      row: s.storage.sql
        .exec<{ value: string }>(
          "select value from meta where key = 'dashboard_push_due'",
        )
        .toArray()[0]?.value,
    }));
    expect(Number(due.row)).toBe(t0 + 500);
    expect(due.alarm).toBeLessThanOrEqual(t0 + 500);
    await clock(h, t0 + 600);
    expect(
      await runDurableObjectAlarm(h as unknown as DurableObjectStub<Hub>),
    ).toBe(true);
    const last = await push(o);
    expect(last.agents.length).toBe(20);
    await tick();
    expect(o.pending()).toBe(0);
    await clock(h, null);
    o.ws.close();
    d.ws.close();
  });

  it("a push outside the window goes out at once", async () => {
    const h = freshHub();
    const o = await observer(h);
    await snapshot(o);
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    await machineOn(h, "One");
    await push(o);
    await clock(h, t0 + 501);
    await machineOn(h, "Two");
    const p = await push(o);
    expect(p.machines.map((m) => m.label)).toContain("Two");
    await clock(h, null);
    o.ws.close();
  });
});

describe("bad stored rows", () => {
  it("P2: a non-canonical row is skipped; the rest of the feed survives", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    await inHub(h, (_, s) => {
      seedAgent(s, { machineId: mid, namespace: "Not Canonical", name: "bad" });
      seedAgent(s, { machineId: mid, namespace: "ns-ok", name: "good" });
    });
    const list = await h.listAgents();
    expect(list.map((a) => a.name)).toEqual(["good"]);
    const r = await rawObserver(h);
    await r.next();
    await r.next();
    const agents = BusEventSchema.parse(JSON.parse(await r.next()));
    if (agents.type !== "agents") throw new Error();
    expect(agents.agents.map((a) => a.name)).toEqual(["good"]);
    // Pushes survive it too.
    await machineOn(h, "After");
    const m = BusEventSchema.parse(JSON.parse(await r.next()));
    const a = BusEventSchema.parse(JSON.parse(await r.next()));
    expect(m.type).toBe("machines");
    expect(a.type === "agents" && a.agents.map((x) => x.name)).toEqual([
      "good",
    ]);
    r.ws.close();
  });

  it("P2b: an out-of-range timestamp never throws; that row is skipped", async () => {
    expect(() => iso(9e15)).not.toThrow();
    expect(() => iso(Number.NaN)).not.toThrow();
    const h = freshHub();
    const mid = await machineOn(h);
    const bad = await machineOn(h, "BadTime");
    await inHub(h, (_, s) => {
      seedAgent(s, { machineId: mid, namespace: "ns-x", name: "late" });
      seedAgent(s, { machineId: mid, namespace: "ns-x", name: "fine" });
      s.storage.sql.exec(
        "update agents set updated_at = 9e15 where name = 'late'",
      );
      s.storage.sql.exec(
        "update machines set created_at = 9e15 where id = ?",
        bad,
      );
    });
    expect((await h.listAgents()).map((a) => a.name)).toEqual(["fine"]);
    const o = await observer(h);
    const [, m, a] = await snapshot(o);
    expect(m.type === "machines" && m.machines.map((x) => x.label)).toEqual([
      "MacBook",
    ]);
    expect(a.type === "agents" && a.agents.map((x) => x.name)).toEqual([
      "fine",
    ]);
    await machineOn(h, "After");
    const p = await push(o);
    expect(p.agents.map((x) => x.name)).toEqual(["fine"]);
    o.ws.close();
  });
});

describe("webSocketError", () => {
  it("P3: an error on a still-open daemon socket closes it (1011) and pushes it disconnected", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const n = ns("err");
    const d = await daemonOn(h, mid);
    const closed = new Promise<number>((r) =>
      d.ws.addEventListener("close", (ev) => r(ev.code)),
    );
    d.send(up("u1", "r1", "alice", n));
    await until(d, "agent_ok");
    const o = await observer(h);
    await snapshot(o);
    await inHub(h, async (i, s) => {
      const ws = s.getWebSockets(mid)[0] as WebSocket;
      await i.webSocketError(ws, new Error("boom"));
    });
    const p = await push(o);
    expect(p.machines.find((m) => m.id === mid)?.connected).toBe(false);
    expect(p.agents[0]?.state).toBe("queued");
    expect(await closed).toBe(1011);
    o.ws.close();
  });
});

// ------------------------------------------- dashboard WebSocket (B10-ws)

describe("dashboard socket: session expiry header", () => {
  it("400s a missing, non-integer or past x-ob-session-exp; 101 for a future one", async () => {
    const h = freshHub();
    const status = async (headers: Record<string, string>) => {
      const r = await fetchOf(h)(EVENTS_URL, { headers });
      r.webSocket?.accept();
      r.webSocket?.close();
      return r.status;
    };
    expect(await status({ Upgrade: "websocket" })).toBe(400);
    expect(
      await status({ Upgrade: "websocket", [SESSION_GEN_HEADER]: "0" }),
    ).toBe(400);
    for (const bad of [
      "",
      " ",
      "NaN",
      "abc",
      "Infinity",
      "-Infinity",
      "1.5",
      "12abc",
      "0x10",
      "1e15",
      "-5",
      "99999999999999999999",
      String(Date.now() - 1),
      "0",
    ])
      expect(await status(dashHeaders(bad)), JSON.stringify(bad)).toBe(400);
    expect(await status(dashHeaders())).toBe(101);
    // Nothing refused was accepted as a socket.
    expect(
      await inHub(h, (_, s) => s.getWebSockets("dashboard").length),
    ).toBeLessThanOrEqual(1);
  });

  it("an expiry equal to the hub clock is already past (400)", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const at = await fetchOf(h)(EVENTS_URL, { headers: dashHeaders(t0) });
    expect(at.status).toBe(400);
    const after = await fetchOf(h)(EVENTS_URL, {
      headers: dashHeaders(t0 + 1),
    });
    expect(after.status).toBe(101);
    after.webSocket?.accept();
    after.webSocket?.close();
    await clock(h, null);
  });

  it("stores the expiry in the attachment; tags are exactly [dashboard]", async () => {
    const h = freshHub();
    const exp = farExp();
    const o = await observer(h, exp);
    await snapshot(o);
    const seen = await inHub(h, (_, s) =>
      s.getWebSockets("dashboard").map((w) => ({
        tags: s.getTags(w),
        a: w.deserializeAttachment() as Record<string, unknown>,
      })),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tags).toEqual(["dashboard"]);
    expect(seen[0]?.a.exp).toBe(exp);
    expect(seen[0]?.a).not.toHaveProperty("machineId");
    o.ws.close();
  });
});

describe("dashboard socket: 4401 when the session ends", () => {
  it("bumpSessionGeneration closes every dashboard socket with 4401; daemons stay", async () => {
    const h = freshHub();
    const mid = await machineOn(h);
    const d = await daemonOn(h, mid);
    const a = await observer(h);
    const b = await observer(h);
    await snapshot(a);
    await snapshot(b);
    await h.bumpSessionGeneration();
    expect((await a.closed).code).toBe(LIMITS.dashboardSessionClose);
    expect((await b.closed).code).toBe(4401);
    await sync(d);
    expect((await h.listMachines()).find((m) => m.id === mid)?.connected).toBe(
      true,
    );
    d.ws.close();
  });

  it("the alarm closes a socket at its expiry with 4401 and re-arms for the next", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const soon = await observer(h, t0 + 1_000);
    const late = await observer(h, t0 + 10 * HOUR);
    await snapshot(soon);
    await snapshot(late);
    expect(await inHub(h, (_, s) => s.storage.getAlarm())).toBe(t0 + 1_000);
    await clock(h, t0 + 1_000);
    expect(
      await runDurableObjectAlarm(h as unknown as DurableObjectStub<Hub>),
    ).toBe(true);
    expect((await soon.closed).code).toBe(4401);
    await tick();
    expect(late.isClosed()).toBe(false);
    expect(await inHub(h, (_, s) => s.storage.getAlarm())).toBe(t0 + 10 * HOUR);
    await clock(h, t0 + 10 * HOUR);
    expect(
      await runDurableObjectAlarm(h as unknown as DurableObjectStub<Hub>),
    ).toBe(true);
    expect((await late.closed).code).toBe(4401);
    // Nothing left to wait for: the alarm is cleared.
    expect(await inHub(h, (_, s) => s.storage.getAlarm())).toBeNull();
    await clock(h, null);
  });

  it("a push closes an expired socket with 4401 instead of sending to it", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const old = await rawObserver(h, t0 + 1_000);
    for (let k = 0; k < 3; k++) await old.next();
    const fresh = await observer(h, t0 + 10 * HOUR);
    await snapshot(fresh);
    // Past the expiry, before any alarm runs.
    await clock(h, t0 + 2_000);
    await machineOn(h, "Trigger");
    const p = await push(fresh);
    expect(p.machines.map((m) => m.label)).toContain("Trigger");
    expect((await old.closed).code).toBe(4401);
    expect(old.pending()).toBe(0);
    fresh.ws.close();
    await clock(h, null);
  });
});

describe("dashboard socket: client frames and bus isolation", () => {
  it("a fresh hub sets the ping/pong auto-response before any socket", async () => {
    const h = freshHub();
    const ar = await inHub(h, (_, s) => {
      const r = s.getWebSocketAutoResponse();
      return r ? { req: r.request, res: r.response } : null;
    });
    expect(ar).toEqual({ req: PING, res: PONG });
  });

  it('on a fresh hub with no daemon, a dashboard "ping" gets "pong"; other frames get nothing', async () => {
    const h = freshHub();
    const r = await rawObserver(h);
    for (let k = 0; k < 3; k++) await r.next();
    r.ws.send(PING);
    expect(await r.next()).toBe(PONG);
    r.ws.send("pong");
    r.ws.send(JSON.stringify({ type: "hello" }));
    await tick();
    expect(r.pending()).toBe(0);
    expect(r.isClosed()).toBe(false);
    r.ws.close();
  });

  it("never receives bus frames: deliver, receipt_update, roster_changed, refuse, error, list", async () => {
    const h = freshHub();
    const ma = await machineOn(h, "A");
    const mb = await machineOn(h, "B");
    const n = ns("iso");
    const raw = await rawObserver(h);
    const a = await daemonOn(h, ma);
    const b = await daemonOn(h, mb);
    a.send(up("ua", "ra", "alice", n));
    await until(a, "agent_ok");
    b.send(up("ub", "rb", "bob", n));
    await until(b, "agent_ok");
    // deliver + ack -> receipt_update
    a.send({
      v: 1,
      id: "s1",
      type: "send",
      from_ref: "ra",
      to_name: "bob",
      body: "hi",
    });
    const d1 = await until(b, "deliver");
    b.send({ v: 1, id: "k1", type: "ack", msg_id: d1.msg_id });
    await until(a, "receipt_update");
    // refuse -> receipt_update
    a.send({
      v: 1,
      id: "s2",
      type: "send",
      from_ref: "ra",
      to_name: "bob",
      body: "no",
    });
    const d2 = await until(b, "deliver");
    b.send({
      v: 1,
      id: "rf",
      type: "refuse",
      msg_id: d2.msg_id,
      reason: "closed",
      detail: "denied",
    });
    await until(a, "receipt_update");
    // list -> roster; a bad frame -> error
    a.send({ v: 1, id: "l1", type: "list", from_ref: "ra" } as ClientFrame);
    await until(a, "roster");
    a.ws.send("{not json");
    await until(a, "error");
    // roster_changed for a, from bob leaving
    b.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "rb" });
    await until(a, "roster_changed");
    await sync(a);
    await sync(b);
    // Drain through a marker push so every frame sent so far has arrived.
    const label = `marker-${newId()}`;
    await machineOn(h, label);
    for (let k = 0; k < 1000; k++) {
      const t = await raw.next();
      if (t.includes(label)) break;
    }
    await tick();
    for (const t of raw.seen) {
      expect(t, t).not.toMatch(/"v"\s*:\s*1/);
      expect(BusEventSchema.safeParse(JSON.parse(t)).success, t).toBe(true);
    }
    // The hub's daemon set never includes a dashboard socket.
    const tags = await inHub(h, (_, s) => ({
      daemon: s.getWebSockets("daemon").map((w) => s.getTags(w)),
      dash: s.getWebSockets("dashboard").map((w) => s.getTags(w)),
    }));
    expect(tags.daemon.every((t) => !t.includes("dashboard"))).toBe(true);
    expect(tags.dash).toEqual([["dashboard"]]);
    raw.ws.close();
    a.ws.close();
    b.ws.close();
  });
});

// ------------------------------------------------- fix round 1 (adv-B10ws)

describe("dashboard socket: expiry survives eviction (H1)", () => {
  it("a rehydrated Hub's alarm closes the socket at its expiry with 4401", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const o = await observer(h, t0 + 1_000);
    await snapshot(o);
    // Simulated eviction: a brand-new Hub on the same state. Only durable
    // state (the alarm, socket tags and attachments) carries over; no timer.
    const res = await inHub(h, async (_, s) => {
      const alarm = await s.storage.getAlarm();
      const fresh = new Hub(s, e);
      Hub.setTestClock(fresh, t0 + 1_000);
      await fresh.alarm();
      return { alarm, after: await s.storage.getAlarm() };
    });
    expect(res.alarm).toBe(t0 + 1_000);
    expect((await o.closed).code).toBe(4401);
    expect(res.after).toBeNull();
    await clock(h, null);
  });
});

describe("dashboard socket: exp cap and alarm guard (M1)", () => {
  it("400s an exp past now + max age + 1 min, 2^53 or a Date-range one; no socket, alarm intact", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const keep = await observer(h, t0 + 1_000);
    await snapshot(keep);
    const before = await inHub(h, (_, s) => s.storage.getAlarm());
    expect(before).toBe(t0 + 1_000);
    for (const bad of [
      "9999999999999",
      "9007199254740992",
      String(2 ** 53),
      String(t0 + EXP_CAP_MS + 1),
    ]) {
      const r = await fetchOf(h)(EVENTS_URL, { headers: dashHeaders(bad) });
      expect(r.status, bad).toBe(400);
      expect(r.webSocket, bad).toBeNull();
    }
    expect(
      await inHub(h, (_, s) => ({
        n: s.getWebSockets("dashboard").length,
        alarm: s.storage.getAlarm(),
      })).then(async (x) => ({ n: x.n, alarm: await x.alarm })),
    ).toEqual({ n: 1, alarm: t0 + 1_000 });
    // Exactly at the cap is fine.
    const edge = await observer(h, t0 + EXP_CAP_MS);
    await snapshot(edge);
    keep.ws.close();
    edge.ws.close();
    await clock(h, null);
  });

  it("an out-of-range deadline never throws out of the alarm or stalls it", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const near = await observer(h, t0 + 1_000);
    const huge = await observer(h, t0 + 2_000);
    await snapshot(near);
    await snapshot(huge);
    // Bypass the accept check: a stored exp past workerd's alarm range.
    await inHub(h, (_, s) => {
      const w = s
        .getWebSockets("dashboard")
        .find(
          (x) =>
            (x.deserializeAttachment() as { exp: number }).exp === t0 + 2_000,
        ) as WebSocket;
      w.serializeAttachment({
        ...(w.deserializeAttachment() as object),
        exp: Number.MAX_SAFE_INTEGER,
      });
    });
    await clock(h, t0 + 1_000);
    expect(
      await runDurableObjectAlarm(h as unknown as DurableObjectStub<Hub>),
    ).toBe(true);
    expect((await near.closed).code).toBe(4401);
    // Re-armed (clamped), not lost.
    const alarm = await inHub(h, (_, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm as number).toBeGreaterThan(t0 + 1_000);
    expect(huge.isClosed()).toBe(false);
    huge.ws.close();
    await clock(h, null);
  });
});

describe("dashboard socket: session generation (M2)", () => {
  it("400s a missing or malformed x-ob-session-gen", async () => {
    const h = freshHub();
    for (const bad of [undefined, "", "abc", "-1", "1.0", "+0", "0x0", "1e0"]) {
      const headers: Record<string, string> = {
        Upgrade: "websocket",
        [SESSION_EXP_HEADER]: String(farExp()),
      };
      if (bad !== undefined) headers[SESSION_GEN_HEADER] = bad;
      const r = await fetchOf(h)(EVENTS_URL, { headers });
      expect(r.status, String(bad)).toBe(400);
    }
    expect(await inHub(h, (_, s) => s.getWebSockets("dashboard").length)).toBe(
      0,
    );
  });

  it("400s a stale generation (bumped between the Worker's check and the forward); 101 for the current one", async () => {
    const h = freshHub();
    const atCheck = await h.sessionGeneration();
    const gen = await h.bumpSessionGeneration();
    const stale = await fetchOf(h)(EVENTS_URL, {
      headers: dashHeaders(farExp(), atCheck),
    });
    expect(stale.status).toBe(400);
    expect(await inHub(h, (_, s) => s.getWebSockets("dashboard").length)).toBe(
      0,
    );
    const ok = await fetchOf(h)(EVENTS_URL, {
      headers: dashHeaders(farExp(), gen),
    });
    expect(ok.status).toBe(101);
    const ws = ok.webSocket as WebSocket;
    ws.accept();
    const attach = await inHub(h, (_, s) =>
      s.getWebSockets("dashboard").map((w) => w.deserializeAttachment()),
    );
    expect(attach).toEqual([expect.objectContaining({ gen })]);
    const closed = new Promise<number>((r) =>
      ws.addEventListener("close", (ev) => r(ev.code)),
    );
    await h.bumpSessionGeneration();
    expect(await closed).toBe(4401);
  });
});

describe("dashboard vs daemon close codes, never swapped (L5)", () => {
  it("revoke closes the daemon 4403 and leaves the dashboard open; a bump closes the dashboard 4401 and leaves daemons open", async () => {
    const h = freshHub();
    const victim = await machineOn(h, "Victim");
    const other = await machineOn(h, "Other");
    const dv = await daemonOn(h, victim);
    const vClosed = new Promise<number>((r) =>
      dv.ws.addEventListener("close", (ev) => r(ev.code)),
    );
    const d2 = await daemonOn(h, other);
    let d2Code: number | null = null;
    d2.ws.addEventListener("close", (ev) => {
      d2Code = ev.code;
    });
    const o = await observer(h);
    await snapshot(o);
    expect(await h.revokeMachine(victim)).toBe(true);
    expect(await vClosed).toBe(LIMITS.revokeCloseCode);
    const p = await push(o);
    expect(p.machines.find((m) => m.id === victim)?.revokedAt).not.toBeNull();
    await tick();
    expect(o.isClosed()).toBe(false);
    await h.bumpSessionGeneration();
    expect((await o.closed).code).toBe(LIMITS.dashboardSessionClose);
    await tick();
    expect(d2Code).toBeNull();
    await sync(d2);
    d2.ws.close();
  });
});
