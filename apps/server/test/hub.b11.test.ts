// B11 hardening on the hub: per-socket frame budget, live-agent caps, bounded
// bulk work (sessions{closed}, close cleanup, persisted revoke drain) and the
// hub's structured logs. Every test runs on its own hub (newUniqueId).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  type ClientFrame,
  decodeServerFrame,
  EVENTS_DO_PATH,
  encodeFrame,
  LIMITS,
  newId,
  OWNER_ORG_ID,
  PONG,
  SESSION_EXP_HEADER,
  SESSION_GEN_HEADER,
  type ServerFrame,
} from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_BUDGET, Hub, type HubStub, SWEEP_BATCH } from "../src/hub/do.js";
import { e, hello, ns, up } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;
const stubOf = (h: HubStub) => h as unknown as DurableObjectStub<Hub>;
const inHub = <R>(h: HubStub, fn: (i: Hub, s: DurableObjectState) => R) =>
  runInDurableObject(stubOf(h), (i: Hub, s) => fn(i, s));
const clock = (h: HubStub, ms: number | null) =>
  inHub(h, (i) => Hub.setTestClock(i, ms));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

type D = {
  ws: WebSocket;
  seen: ServerFrame[];
  next: () => Promise<ServerFrame>;
  send: (f: ClientFrame) => void;
  closed: Promise<{ code: number; reason: string }>;
  isClosed: () => boolean;
};

function wire(ws: WebSocket, decode: boolean): Omit<D, "send"> {
  ws.accept();
  const queue: ServerFrame[] = [];
  const waiting: ((f: ServerFrame) => void)[] = [];
  const seen: ServerFrame[] = [];
  let done = false;
  ws.addEventListener("message", (ev) => {
    const t = String(ev.data);
    if (!decode || t === PONG) return;
    const r = decodeServerFrame(t);
    expect(r.ok, `not a server frame: ${t}`).toBe(true);
    if (!r.ok) return;
    seen.push(r.frame);
    const w = waiting.shift();
    if (w) w(r.frame);
    else queue.push(r.frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => {
      done = true;
      resolve({ code: ev.code, reason: ev.reason });
    }),
  );
  const next = () => {
    const f = queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 15_000);
      waiting.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  };
  return { ws, seen, next, closed, isClosed: () => done };
}

async function daemonOn(h: HubStub, machineId: string): Promise<D> {
  const res = await stubOf(h).fetch("https://hub.internal/hub", {
    headers: { Upgrade: "websocket", "X-Ob-Machine-Id": machineId },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  return { ...wire(ws, true), send: (f) => ws.send(encodeFrame(f)) };
}

async function dashboardOn(h: HubStub): Promise<D> {
  const res = await stubOf(h).fetch(`https://hub.internal${EVENTS_DO_PATH}`, {
    headers: {
      Upgrade: "websocket",
      [SESSION_EXP_HEADER]: String(Date.now() + 24 * 3_600_000),
      [SESSION_GEN_HEADER]: "0",
    },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  return { ...wire(ws, false), send: (f) => ws.send(encodeFrame(f)) };
}

async function until<T extends ServerFrame["type"]>(d: D, type: T) {
  for (let i = 0; i < 5000; i++) {
    const f = await d.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type}`);
}

async function machineOn(h: HubStub, label = "MacBook") {
  const m = await h.createMachine(label);
  if (!m.ok) throw new Error(m.code);
  return m;
}

/** Seeds `n` live agents on a machine straight into SQL (bypassing caps). */
const seedAgents = (
  h: HubStub,
  machineId: string,
  n: number,
  namespace: string,
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
         values (?, ?, ?, ?, 'claude-code', ?, ?, 0, 1, 0)`,
        id,
        OWNER_ORG_ID,
        namespace,
        `seed-${machineId.slice(0, 4)}-${i}`,
        machineId,
        `seed_${i}`,
      );
    }
    return ids;
  });

/** Seeds receipts to `toAgent` (state as given), with a mail row when `body`. */
const seedReceipts = (
  h: HubStub,
  toAgent: string,
  n: number,
  opts: { state: "pending" | "delivered"; body: boolean; now: number },
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    const exp = opts.now + LIMITS.mailTtlSec * 1000;
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, final_at)
         values (?, ?, 'seed', ?, 'to', 'nobody', 'from', ?, ?, ?, ?, ?, ?)`,
        id,
        OWNER_ORG_ID,
        toAgent,
        opts.state,
        LIMITS.inlineBodyBytes + 1,
        opts.now,
        exp,
        opts.state === "delivered" ? opts.now : null,
        opts.state === "delivered" ? opts.now : null,
      );
      if (opts.body)
        s.storage.sql.exec(
          "insert into mail (id, org_id, body, created_at, expires_at) values (?, ?, 'b', ?, ?)",
          id,
          OWNER_ORG_ID,
          opts.now,
          exp,
        );
    }
    return ids;
  });

const count = (h: HubStub, q: string, ...b: SqlStorageValue[]) =>
  inHub(
    h,
    (_, s) => s.storage.sql.exec<{ n: number }>(q, ...b).toArray()[0]?.n ?? 0,
  );

/**
 * Runs the alarm until `done` (the alarm may also fire on its own at now + 1,
 * so a false from runDurableObjectAlarm is not "finished").
 */
async function drain(h: HubStub, done: () => Promise<boolean>) {
  for (let k = 0; k < 200; k++) {
    if (await done()) return;
    await runDurableObjectAlarm(stubOf(h));
    await tick(5);
  }
}

const hellos = (d: D, n: number, tag: string) => {
  for (let k = 0; k < n; k++) d.send(hello(`${tag}-${k}`));
};

/** console.log lines that are JSON events named `evt`. */
const events = (spy: { mock: { calls: unknown[][] } }, evt: string) =>
  spy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(String(c[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x?.evt === evt);

// ------------------------------------------------------------ frame budget

describe("per-socket frame budget", () => {
  it("is 50 frames per second", () => {
    expect(FRAME_BUDGET).toEqual({ frames: 50, windowMs: 1000 });
  });

  it("50 frames pass; the 51st closes the socket with 1008 rate limited", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    await clock(h, Date.now());
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    hellos(d, FRAME_BUDGET.frames, "a");
    for (let k = 0; k < FRAME_BUDGET.frames; k++) await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    d.send(hello("over"));
    const c = await d.closed;
    expect(c).toEqual({
      code: LIMITS.protocolCloseCode,
      reason: "rate limited",
    });
    expect(d.seen.filter((f) => f.type === "hello_ok")).toHaveLength(
      FRAME_BUDGET.frames,
    );
    expect(events(log, "rate_limited")).toEqual([
      { evt: "rate_limited", kind: "frames", machineId: m.id },
    ]);
  });

  it("the budget resets after the window", async () => {
    const h = freshHub();
    const t0 = Date.now();
    await clock(h, t0);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    hellos(d, FRAME_BUDGET.frames, "a");
    for (let k = 0; k < FRAME_BUDGET.frames; k++) await until(d, "hello_ok");
    await clock(h, t0 + FRAME_BUDGET.windowMs);
    hellos(d, FRAME_BUDGET.frames, "b");
    for (let k = 0; k < FRAME_BUDGET.frames; k++) await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    await clock(h, null);
  });

  it("a bare ping is answered by the auto-response and never counts", async () => {
    const h = freshHub();
    await clock(h, Date.now());
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    for (let k = 0; k < FRAME_BUDGET.frames * 2; k++) d.ws.send("ping");
    hellos(d, FRAME_BUDGET.frames, "a");
    for (let k = 0; k < FRAME_BUDGET.frames; k++) await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
  });

  it("dashboard sockets are counted too and close at the same cap", async () => {
    const h = freshHub();
    await clock(h, Date.now());
    const o = await dashboardOn(h);
    for (let k = 0; k < FRAME_BUDGET.frames; k++) o.ws.send(`x${k}`);
    await tick(100);
    expect(o.isClosed()).toBe(false);
    o.ws.send("one too many");
    expect(await o.closed).toEqual({
      code: LIMITS.protocolCloseCode,
      reason: "rate limited",
    });
  });
});

// ---------------------------------------------------------- live-agent caps

describe("live-agent caps", () => {
  it("pins the shared caps", () => {
    expect(LIMITS.maxAgentsPerMachine).toBe(200);
    expect(LIMITS.maxRosterAgents).toBe(1000);
  });

  it("per machine: agent_up past maxAgentsPerMachine gets rate_limited; the socket stays open", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const n = ns("cap");
    const m = await machineOn(h);
    await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine - 1, n);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "last", "Last", n));
    expect(await until(d, "agent_ok")).toMatchObject({ id: "u1" });
    d.send(up("u2", "over", "Over", n));
    const err = await until(d, "error");
    expect(err).toMatchObject({ id: "u2", code: "rate_limited" });
    expect(
      await count(
        h,
        "select count(*) as n from agents where machine_id = ? and live = 1",
        m.id,
      ),
    ).toBe(LIMITS.maxAgentsPerMachine);
    // A re-up of an agent already live is not a new one: still accepted.
    d.send(up("u3", "last", "Last", n));
    expect(await until(d, "agent_ok")).toMatchObject({ id: "u3" });
    d.send(hello("still-open"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    expect(events(log, "cap_refused")).toEqual([
      { evt: "cap_refused", kind: "machine", machineId: m.id },
    ]);
  });

  it("per org: agent_up past maxRosterAgents live agents gets rate_limited", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const n = ns("org");
    const per = LIMITS.maxAgentsPerMachine;
    for (let k = 0; k < LIMITS.maxRosterAgents / per; k++) {
      const other = await machineOn(h, `Other ${k}`);
      await seedAgents(h, other.id, per, n);
    }
    const m = await machineOn(h, "Mine");
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "mine", "Mine", n));
    expect(await until(d, "error")).toMatchObject({
      id: "u1",
      code: "rate_limited",
    });
    expect(events(log, "cap_refused")).toEqual([
      { evt: "cap_refused", kind: "org", machineId: m.id },
    ]);
    d.send(hello("open"));
    await until(d, "hello_ok");
  });
});

// --------------------------------------------------------- bounded bulk work

describe("sessions{closed} at the schema cap", () => {
  it("1000 refs (200 live, each with a full inbox) close in one frame; time logged", async () => {
    const h = freshHub();
    const n = ns("bulk");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    const now = Date.now();
    const per = LIMITS.inboxCap;
    for (const id of ids)
      await seedReceipts(h, id, per, { state: "pending", body: true, now });
    const d = await daemonOn(h, m.id);
    const closed = Array.from({ length: LIMITS.maxRosterAgents }, (_, i) =>
      i < ids.length ? `seed_${i}` : `ghost_${i}`,
    );
    const t0 = performance.now();
    d.send({ v: 1, id: "ss", type: "sessions", open: [], closed });
    d.send(hello("after"));
    await until(d, "hello_ok");
    const ms = performance.now() - t0;
    console.info(
      `B11 measure: sessions{closed: ${closed.length} refs, ${ids.length} live, ${ids.length * per} pending} round trip ${ms.toFixed(1)} ms`,
    );
    expect(
      await count(
        h,
        "select count(*) as n from agents where machine_id = ? and live = 1",
        m.id,
      ),
    ).toBe(0);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'pending'",
      ),
    ).toBe(0);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
  });
});

describe("close cleanup (B8) is bounded by SWEEP_BATCH", () => {
  it("agent_down drops one batch of acked-unfetched notice bodies; the expired-mail step sweeps the rest", async () => {
    const h = freshHub();
    const t0 = Date.now();
    await clock(h, t0);
    const n = ns("close");
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const agentId = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ id: string }>(
            "select id from agents where native_ref = 'victim'",
          )
          .one().id,
    );
    const extra = 10;
    await seedReceipts(h, agentId, SWEEP_BATCH + extra, {
      state: "delivered",
      body: true,
      now: t0,
    });
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    d.send(hello("sync"));
    await until(d, "hello_ok");
    expect(await count(h, "select count(*) as n from mail")).toBe(extra);
    // A real send armed the alarm for its body's expiry; the seed did not.
    await inHub(h, (_, s) => s.storage.setAlarm(t0 + LIMITS.mailTtlSec * 1000));
    await clock(h, t0 + LIMITS.mailTtlSec * 1000 + 1);
    await drain(
      h,
      async () => (await count(h, "select count(*) as n from mail")) === 0,
    );
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
    await clock(h, null);
  });
});

describe("revoke drain (B9) is persisted", () => {
  const pendingRevoked = (h: HubStub) =>
    count(
      h,
      "select count(*) as n from receipts where state = 'expired' and reason = 'revoked'",
    );
  const pending = (h: HubStub) =>
    count(h, "select count(*) as n from receipts where state = 'pending'");

  it("an eviction mid-drain still finishes: a rehydrated hub's alarm drains the rest as revoked", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const now = Date.now();
    const n = ns("evict");
    const m = await machineOn(h);
    const agents = await seedAgents(h, m.id, 3, n);
    for (const a of agents)
      await seedReceipts(h, a, 30, { state: "pending", body: true, now });
    expect(await h.revokeMachine(m.id)).toBe(true);
    expect(await pendingRevoked(h)).toBe(SWEEP_BATCH);
    // Simulated eviction: a brand-new Hub on the same state, then its alarm.
    const left = await inHub(h, async (_, s) => {
      const fresh = new Hub(s, e);
      for (let k = 0; k < 5; k++) await fresh.alarm();
      return s.storage.sql
        .exec<{ n: number }>(
          "select count(*) as n from receipts where state = 'pending'",
        )
        .one().n;
    });
    expect(left).toBe(0);
    expect(await pendingRevoked(h)).toBe(90);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
    expect(events(log, "machine_revoked")).toEqual([
      { evt: "machine_revoked", machineId: m.id },
    ]);
  });

  it("has no 1000-agent ceiling", async () => {
    const h = freshHub();
    const now = Date.now();
    const n = ns("many");
    const m = await machineOn(h);
    const agents = await seedAgents(h, m.id, LIMITS.maxRosterAgents + 5, n);
    // One pending receipt each, for the last few agents past the old ceiling.
    for (const a of agents.slice(-10))
      await seedReceipts(h, a, 1, { state: "pending", body: true, now });
    expect(await h.revokeMachine(m.id)).toBe(true);
    await drain(h, async () => (await pending(h)) === 0);
    expect(await pending(h)).toBe(0);
    expect(await pendingRevoked(h)).toBe(10);
    // The persisted queue is empty once drained.
    expect(
      await count(
        h,
        "select count(*) as n from meta where key like 'revoke_drain:%'",
      ),
    ).toBe(0);
  });

  it("drops revoked agents' acked-unfetched notice bodies past one batch", async () => {
    const h = freshHub();
    const now = Date.now();
    const n = ns("bodies");
    const m = await machineOn(h);
    const [a] = await seedAgents(h, m.id, 1, n);
    await seedReceipts(h, a as string, SWEEP_BATCH * 2 + 3, {
      state: "delivered",
      body: true,
      now,
    });
    expect(await h.revokeMachine(m.id)).toBe(true);
    await drain(
      h,
      async () => (await count(h, "select count(*) as n from mail")) === 0,
    );
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
  });
});

// ------------------------------------------------------------------- logs

describe("hub logs", () => {
  it("hub_reject carries the code and machine id, and no log line carries a token", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.ws.send("{not json");
    await until(d, "error");
    d.send({
      v: 1,
      id: "l1",
      type: "list",
      from_ref: "nobody",
    } as ClientFrame);
    await until(d, "error");
    expect(events(log, "hub_reject")).toEqual([
      { evt: "hub_reject", code: "bad_frame", machineId: m.id },
      { evt: "hub_reject", code: "not_registered", machineId: m.id },
    ]);
    await h.revokeMachine(m.id);
    const all = JSON.stringify(log.mock.calls);
    expect(all).not.toContain(m.token);
    expect(all).not.toMatch(/ob_machine_/);
  });
});
