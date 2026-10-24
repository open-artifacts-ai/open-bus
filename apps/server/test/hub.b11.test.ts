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
import {
  CLOSE_INLINE_BATCH,
  FRAME_BUDGET,
  Hub,
  type HubStub,
  MAX_OIDC_STATES,
  SWEEP_BATCH,
} from "../src/hub/do.js";
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
  opts: {
    state: "pending" | "delivered";
    body: boolean;
    now: number;
    from?: string;
  },
) =>
  inHub(h, (_, s) => {
    const ids: string[] = [];
    const exp = opts.now + LIMITS.mailTtlSec * 1000;
    for (let i = 0; i < n; i++) {
      const id = newId();
      ids.push(id);
      s.storage.sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, final_at)
         values (?, ?, 'seed', ?, 'to', ?, 'from', ?, ?, ?, ?, ?, ?)`,
        id,
        OWNER_ORG_ID,
        toAgent,
        opts.from ?? "nobody",
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

/** An ack for an unknown msg_id: a frame the hub ignores without a reply. */
const junkAck = (): ClientFrame => ({
  v: 1,
  id: newId(),
  type: "ack",
  msg_id: newId(),
});
const acks = (d: D, n: number) => {
  for (let k = 0; k < n; k++) d.send(junkAck());
};
const HOUR = 3_600_000;

describe("per-socket frame budget (token bucket)", () => {
  it("refills 50/s; the burst covers a full reconnect, derived from LIMITS", () => {
    expect(FRAME_BUDGET.refillPerSec).toBe(50);
    expect(FRAME_BUDGET.burst).toBe(
      2 + LIMITS.maxAgentsPerMachine * (1 + LIMITS.inboxCap),
    );
  });

  it("a reconnect (hello, 200 agent_ups, acks for a 50-message flush) as fast as possible is never closed", async () => {
    const h = freshHub();
    const n = ns("reconnect");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    await seedReceipts(h, ids[0] as string, LIMITS.inboxCap, {
      state: "pending",
      body: true,
      now: Date.now(),
    });
    const d = await daemonOn(h, m.id);
    d.send(hello("h"));
    for (let i = 0; i < LIMITS.maxAgentsPerMachine; i++)
      d.send(up(`u${i}`, `seed_${i}`, `seed-${m.id.slice(0, 4)}-${i}`, n));
    for (let k = 0; k < LIMITS.inboxCap; k++) {
      const f = await until(d, "deliver");
      d.send({ v: 1, id: `a${k}`, type: "ack", msg_id: f.msg_id });
    }
    d.send(hello("sync"));
    for (;;) if ((await until(d, "hello_ok")).id === "sync") break;
    expect(d.isClosed()).toBe(false);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'delivered'",
      ),
    ).toBe(LIMITS.inboxCap);
  });

  it("a sustained flood well above the refill rate is closed with 1008 rate limited, logged once", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    // Real clock: the flood outruns the 50/s refill until the burst is gone.
    for (let k = 0; k < 4 * FRAME_BUDGET.burst && !d.isClosed(); k++) {
      d.send(junkAck());
      if (k % 500 === 0) await tick(1);
    }
    expect(await d.closed).toEqual({
      code: LIMITS.protocolCloseCode,
      reason: "rate limited",
    });
    expect(events(log, "rate_limited")).toEqual([
      { evt: "rate_limited", kind: "frames", machineId: m.id },
    ]);
  }, 120_000);

  /** Empties the socket's bucket on the hub side (the socket tagged `tag`). */
  const emptyBucket = (h: HubStub, tag: string, tokens = 0) =>
    inHub(h, (i, s) => {
      for (const ws of s.getWebSockets(tag))
        Hub.setFrameTokensForTests(i, ws, tokens);
    });

  it("refills at 50 tokens per second", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await emptyBucket(h, m.id, 1);
    d.send(hello("last"));
    await until(d, "hello_ok");
    await clock(h, t0 + 1000);
    acks(d, FRAME_BUDGET.refillPerSec - 1);
    d.send(hello("refilled"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    d.send(junkAck());
    expect((await d.closed).code).toBe(LIMITS.protocolCloseCode);
  });

  it("a bare ping is answered by the auto-response and never counts", async () => {
    const h = freshHub();
    await clock(h, Date.now() + HOUR);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await emptyBucket(h, m.id, 1);
    for (let k = 0; k < 100; k++) d.ws.send("ping");
    await tick(100);
    d.send(hello("last"));
    await until(d, "hello_ok");
    expect(d.isClosed()).toBe(false);
    d.send(junkAck());
    expect((await d.closed).code).toBe(LIMITS.protocolCloseCode);
  });

  it("dashboard sockets are counted too and close once the bucket is empty", async () => {
    const h = freshHub();
    await clock(h, Date.now() + HOUR);
    const o = await dashboardOn(h);
    await emptyBucket(h, "dashboard", 1);
    o.ws.send("x");
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

/** A connected sender machine with one registered agent; returns its agent id. */
async function senderOn(h: HubStub, n: string) {
  const m = await machineOn(h, "Sender");
  const d = await daemonOn(h, m.id);
  d.send(up("su", "sender", "Sender", n));
  await until(d, "agent_ok");
  const id = await inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where machine_id = ? and native_ref = 'sender'",
          m.id,
        )
        .one().id,
  );
  return { d, id };
}

const agentIdOf = (h: HubStub, machineId: string, ref: string) =>
  inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where machine_id = ? and native_ref = ?",
          machineId,
          ref,
        )
        .one().id,
  );

const pendingCount = (h: HubStub) =>
  count(h, "select count(*) as n from receipts where state = 'pending'");

/** Runs the alarm by hand (the frozen clock is ahead, so it never fires itself). */
const alarmOnce = (h: HubStub) => runDurableObjectAlarm(stubOf(h));

/** Round-trips a hello so every frame sent before it has been handled. */
async function sync(d: D) {
  const id = `sync-${newId()}`;
  d.send(hello(id));
  for (;;) {
    const f = await d.next();
    if (f.type === "hello_ok" && f.id === id) return;
  }
}

describe("closed-session work drains from the alarm", () => {
  it("spends CLOSE_INLINE_BATCH (10) inline per frame", () => {
    expect(CLOSE_INLINE_BATCH).toBe(10);
  });

  it("sessions{closed} with 10,000 pending: one batch inline, the rest one batch per alarm run, every sender told once", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("bulk");
    const s = await senderOn(h, n);
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    const msgIds: string[] = [];
    for (const id of ids)
      msgIds.push(
        ...(await seedReceipts(h, id, LIMITS.inboxCap, {
          state: "pending",
          body: true,
          now: t0 - 10,
          from: s.id,
        })),
      );
    const total = msgIds.length;
    expect(total).toBe(10_000);
    const d = await daemonOn(h, m.id);
    const closed = Array.from({ length: LIMITS.maxRosterAgents }, (_, i) =>
      i < ids.length ? `seed_${i}` : `ghost_${i}`,
    );
    // Warm-up: the first large frame pays the decoder's JIT; the measured
    // frame below is the steady-state handler (ghost refs cost only decode).
    const g0 = performance.now();
    d.send({
      v: 1,
      id: "warm",
      type: "sessions",
      open: [],
      closed: closed.map((r) => `warm_${r}`),
    });
    await sync(d);
    console.info(
      `B11 measure: warm-up sessions{closed: ${closed.length} unknown refs} ${(performance.now() - g0).toFixed(1)} ms`,
    );
    const p0 = performance.now();
    d.send({ v: 1, id: "ss", type: "sessions", open: [], closed });
    await sync(d);
    console.info(
      `B11 measure: sessions{closed: ${closed.length} refs, ${ids.length} live, ${total} pending} handler round trip ${(performance.now() - p0).toFixed(1)} ms`,
    );
    expect(
      await count(
        h,
        "select count(*) as n from agents where machine_id = ? and live = 1",
        m.id,
      ),
    ).toBe(0);
    let left = await pendingCount(h);
    expect(left).toBe(total - CLOSE_INLINE_BATCH);
    let runs = 0;
    while (left > 0 && runs < 1000) {
      await alarmOnce(h);
      runs++;
      const now = await pendingCount(h);
      expect(left - now).toBeLessThanOrEqual(SWEEP_BATCH);
      left = now;
    }
    expect(left).toBe(0);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'expired' and reason = 'recipient_closed' and notified_at is not null",
      ),
    ).toBe(total);
    await sync(s.d);
    const told = new Map<string, number>();
    for (const f of s.d.seen)
      if (f.type === "receipt_update") {
        expect(f).toMatchObject({
          state: "expired",
          reason: "recipient_closed",
        });
        told.set(f.msg_id, (told.get(f.msg_id) ?? 0) + 1);
      }
    expect(told.size).toBe(total);
    for (const id of msgIds) expect(told.get(id)).toBe(1);
  }, 120_000);

  it("a reopen mid-drain gets none of the old mail; the drain still expires it; new mail is untouched", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("reopen");
    const s = await senderOn(h, n);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const victim = await agentIdOf(h, m.id, "victim");
    const old = await seedReceipts(h, victim, 120, {
      state: "pending",
      body: true,
      now: t0 - 10,
      from: s.id,
    });
    // agent_down takes the same path as sessions{closed}.
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    await sync(d);
    expect(await pendingCount(h)).toBe(120 - CLOSE_INLINE_BATCH);

    await clock(h, t0 + 10);
    d.seen.length = 0;
    d.send(up("u2", "victim", "Victim", n));
    await until(d, "agent_ok");
    await sync(d);
    const oldSet = new Set(old);
    expect(
      d.seen.filter((f) => f.type === "deliver" && oldSet.has(f.msg_id)),
    ).toEqual([]);
    // Acks for old mail from the reopened session are ignored.
    for (const id of old)
      d.send({ v: 1, id: `a-${id}`, type: "ack", msg_id: id });
    await sync(d);

    s.d.send({
      v: 1,
      id: "fresh",
      type: "send",
      from_ref: "sender",
      to_name: "Victim",
      body: "new session",
    });
    const fresh = await until(s.d, "receipt");
    expect(fresh.state).toBe("pending");
    expect((await until(d, "deliver")).msg_id).toBe(fresh.msg_id);

    for (let k = 0; k < 20 && (await pendingCount(h)) > 1; k++)
      await alarmOnce(h);
    for (const id of old)
      expect(
        await count(
          h,
          "select count(*) as n from receipts where id = ? and state = 'expired' and reason = 'recipient_closed'",
          id,
        ),
      ).toBe(1);
    expect(
      await count(
        h,
        "select count(*) as n from receipts where id = ? and state = 'pending'",
        fresh.msg_id,
      ),
    ).toBe(1);
    await sync(s.d);
    const told = s.d.seen.filter((f) => f.type === "receipt_update");
    expect(told.length).toBe(old.length);
    expect(
      new Set(told.map((f) => (f.type === "receipt_update" ? f.msg_id : "")))
        .size,
    ).toBe(old.length);
  }, 60_000);

  it("acked notices past one batch: a reopened session fetches none (not_found); the drain deletes the bodies", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("m1");
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const victim = await agentIdOf(h, m.id, "victim");
    const extra = 10;
    const notices = await seedReceipts(h, victim, SWEEP_BATCH + extra, {
      state: "delivered",
      body: true,
      now: t0 - 10,
    });
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    await sync(d);
    const leftover = notices.length - CLOSE_INLINE_BATCH;
    expect(await count(h, "select count(*) as n from mail")).toBe(leftover);

    await clock(h, t0 + 10);
    d.send(up("u2", "victim", "Victim", n));
    await until(d, "agent_ok");
    for (const id of notices) {
      d.send({
        v: 1,
        id: `f-${id}`,
        type: "fetch",
        from_ref: "victim",
        msg_id: id,
      });
      expect(await until(d, "error")).toMatchObject({
        id: `f-${id}`,
        code: "not_found",
      });
    }
    // The leftover window: the rows still exist, yet none was served.
    expect(await count(h, "select count(*) as n from mail")).toBe(leftover);
    for (let k = 0; k < 5; k++) await alarmOnce(h);
    expect(await count(h, "select count(*) as n from mail")).toBe(0);
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

// ------------------------------------------------------- RL_AUTH fallback

describe("in-DO cap on stored OIDC states (the RL_AUTH fallback)", () => {
  it("at MAX_OIDC_STATES, a new login is refused (rate_limited) and nothing unexpired is evicted; a replay is still refused", async () => {
    const h = freshHub();
    const now = Date.now();
    await inHub(h, (_, s) => {
      for (let i = 0; i < MAX_OIDC_STATES; i++)
        s.storage.sql.exec(
          "insert into oidc_states (org_id, state, expires_at) values (?, ?, ?)",
          OWNER_ORG_ID,
          `seed-${i}`,
          now + 60_000 + i,
        );
    });
    expect(await h.consumeState("fresh", now + 30 * 60_000)).toBe(
      "rate_limited",
    );
    expect(await count(h, "select count(*) as n from oidc_states")).toBe(
      MAX_OIDC_STATES,
    );
    expect(
      await count(
        h,
        "select count(*) as n from oidc_states where state in ('seed-0', 'fresh')",
      ),
    ).toBe(1);
    // A replay of an old consumed state is still refused (false, not stored).
    expect(await h.consumeState("seed-0", now + 30 * 60_000)).toBe(false);
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
