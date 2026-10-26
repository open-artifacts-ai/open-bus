// B11 fix round 1: the ADV-B11 probes (P1, P2, P3, P5, P6) ported with the
// fixed behavior asserted, plus the manager pins (4429 close + cooldown,
// burst 512, dashboard bucket). Every test runs on its own hub.
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
  DASHBOARD_FRAME_BUDGET,
  DELETE_DELIVERED_BODIES_SQL,
  DELIVERED_BODIES_SELECT_SQL,
  FRAME_BUDGET,
  Hub,
  type HubStub,
  MAX_OIDC_STATES,
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
          "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'b', ?, ?)",
          id,
          OWNER_ORG_ID,
          toAgent,
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

import { logError, logEvent } from "../src/util/log.js";

/** Empties a socket's bucket on the hub side (sockets tagged `tag`). */
const emptyBucket = (h: HubStub, tag: string, tokens = 0) =>
  inHub(h, (i, s) => {
    for (const ws of s.getWebSockets(tag))
      Hub.setFrameTokensForTests(i, ws, tokens);
  });

describe("M2/M3 + manager pin: machine-keyed bucket, burst 512, 4429 and cooldown", () => {
  it("pins the shared close code and cooldown", () => {
    expect(LIMITS.rateLimitCloseCode).toBe(4429);
    expect(LIMITS.rateLimitCooldownMs).toBe(10_000);
  });

  it("M3: daemon burst 512 at 50/s; dashboards 16 at 1/s", () => {
    expect(FRAME_BUDGET).toEqual({ refillPerSec: 50, burst: 512 });
    expect(DASHBOARD_FRAME_BUDGET).toEqual({ refillPerSec: 1, burst: 16 });
  });

  it("P1: a reconnect inherits the machine's bucket: draining socket 1 then reconnecting still closes on flood", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const m = await machineOn(h);
    const d1 = await daemonOn(h, m.id);
    await sync(d1);
    await emptyBucket(h, m.id, 0);
    d1.send(junkAck());
    expect((await d1.closed).code).toBe(LIMITS.rateLimitCloseCode);
    // Past the cooldown, but with no time for the bucket to refill much.
    await clock(h, t0 + LIMITS.rateLimitCooldownMs);
    const d2 = await daemonOn(h, m.id);
    const N = 5000;
    for (let k = 0; k < N && !d2.isClosed(); k++) d2.send(junkAck());
    expect(await d2.closed).toEqual({
      code: LIMITS.rateLimitCloseCode,
      reason: "rate limited",
    });
  }, 60_000);

  it("a flood closes with 4429; an immediate reconnect gets 429; after the cooldown it succeeds", async () => {
    const log = vi.spyOn(console, "log");
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    acks(d, FRAME_BUDGET.burst + 5);
    expect(await d.closed).toEqual({
      code: LIMITS.rateLimitCloseCode,
      reason: "rate limited",
    });
    expect(events(log, "rate_limited")).toEqual([
      { evt: "rate_limited", kind: "frames", machineId: m.id },
    ]);
    const again = await stubOf(h).fetch("https://hub.internal/hub", {
      headers: { Upgrade: "websocket", "X-Ob-Machine-Id": m.id },
    });
    expect(again.status).toBe(429);
    expect(again.webSocket).toBeNull();
    await clock(h, t0 + LIMITS.rateLimitCooldownMs - 1);
    const still = await stubOf(h).fetch("https://hub.internal/hub", {
      headers: { Upgrade: "websocket", "X-Ob-Machine-Id": m.id },
    });
    expect(still.status).toBe(429);
    await clock(h, t0 + LIMITS.rateLimitCooldownMs + 5_000);
    const d2 = await daemonOn(h, m.id);
    await sync(d2);
    expect(d2.isClosed()).toBe(false);
  }, 60_000);

  it("dashboards: 16 instant frames pass, the 17th closes with 4429", async () => {
    const h = freshHub();
    await clock(h, Date.now() + HOUR);
    const o = await dashboardOn(h);
    for (let k = 0; k < DASHBOARD_FRAME_BUDGET.burst; k++) o.ws.send("x");
    await tick(150);
    expect(o.isClosed()).toBe(false);
    o.ws.send("x");
    expect(await o.closed).toEqual({
      code: LIMITS.rateLimitCloseCode,
      reason: "rate limited",
    });
  });

  it("an instant 252-frame reconnect (hello, 200 agent_ups, 50 flush acks, sync) is never closed", async () => {
    const h = freshHub();
    const n = ns("burst");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    const msgIds = await seedReceipts(h, ids[0] as string, LIMITS.inboxCap, {
      state: "pending",
      body: true,
      now: Date.now(),
    });
    const d = await daemonOn(h, m.id);
    d.send(hello("h"));
    for (let i = 0; i < LIMITS.maxAgentsPerMachine; i++)
      d.send(up(`u${i}`, `seed_${i}`, `seed-${m.id.slice(0, 4)}-${i}`, n));
    // Acks for the flush, sent at once (the daemon dedupes by msg_id).
    for (const id of msgIds)
      d.send({ v: 1, id: `a-${id}`, type: "ack", msg_id: id });
    await sync(d);
    expect(d.isClosed()).toBe(false);
  }, 60_000);

  it("a reconnect at Client's pace (40 frames/s) past the burst is never closed", async () => {
    const h = freshHub();
    const n = ns("paced");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    await seedReceipts(h, ids[0] as string, LIMITS.inboxCap, {
      state: "pending",
      body: true,
      now: Date.now(),
    });
    const d = await daemonOn(h, m.id);
    const frames: ClientFrame[] = [hello("h")];
    for (let i = 0; i < LIMITS.maxAgentsPerMachine; i++)
      frames.push(up(`u${i}`, `seed_${i}`, `seed-${m.id.slice(0, 4)}-${i}`, n));
    // More than the burst in total: only pacing keeps it open.
    while (frames.length < FRAME_BUDGET.burst + 100) frames.push(junkAck());
    for (const f of frames) {
      d.send(f);
      await tick(25);
      if (d.isClosed()) break;
    }
    await sync(d);
    expect(d.isClosed()).toBe(false);
  }, 120_000);
});

describe("M1 (P2): the OIDC cap counts only unexpired states", () => {
  it("1000 states that expired a minute ago do not block a fresh login", async () => {
    const h = freshHub();
    const now = Date.now();
    await inHub(h, (_, s) => {
      for (let i = 0; i < MAX_OIDC_STATES; i++)
        s.storage.sql.exec(
          "insert into oidc_states (org_id, state, expires_at) values (?, ?, ?)",
          OWNER_ORG_ID,
          `old-${i}`,
          now - 60_000,
        );
    });
    expect(await h.consumeState("fresh", now + 30 * 60_000)).toBe(true);
  });
});

describe("H1 (P3): close cleanup cost does not grow with delivered history", () => {
  /** Seeds delivered receipts with no mail row (fetched / inline) to each agent. */
  const seedDelivered = (h: HubStub, ids: string[], per: number, now: number) =>
    inHub(h, (_, s) => {
      for (const a of ids)
        for (let i = 0; i < per; i++)
          s.storage.sql.exec(
            `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, final_at, notified_at)
             values (?, ?, 'seed', ?, 'to', 'nobody', 'from', 'delivered', 10, ?, ?, ?, ?, ?)`,
            newId(),
            OWNER_ORG_ID,
            a,
            now - 1000,
            now + HOUR,
            now - 900,
            now - 900,
            now - 900,
          );
    });

  const measured = new Map<number, number>();
  for (const per of [0, 2500])
    it(`sessions{closed} with 200 live agents, ${per} delivered receipts each (no bodies)`, async () => {
      const h = freshHub();
      const t0 = Date.now() + HOUR;
      await clock(h, t0);
      const n = ns("scan");
      const m = await machineOn(h);
      const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
      if (per > 0) await seedDelivered(h, ids, per, t0);
      const d = await daemonOn(h, m.id);
      await sync(d);
      const closed = ids.map((_, i) => `seed_${i}`);
      d.send({
        v: 1,
        id: "w",
        type: "sessions",
        open: [],
        closed: closed.map((r) => `w_${r}`),
      });
      await sync(d);
      // The cleanup queries themselves, timed in the DO (I/O-free, so the
      // clock is the round trip): one body delete per agent, as a close does.
      const p0 = performance.now();
      d.send({ v: 1, id: "ss", type: "sessions", open: [], closed });
      await sync(d);
      const ms = performance.now() - p0;
      measured.set(per, ms);
      console.info(
        `B11 measure H1: per=${per} total_delivered=${per * ids.length} sessions{closed} round trip ${ms.toFixed(1)} ms` +
          (measured.has(0) && per > 0
            ? ` (x${(ms / Math.max(1, measured.get(0) as number)).toFixed(1)} of 0)`
            : ""),
      );
      const a0 = performance.now();
      await alarmOnce(h);
      console.info(
        `B11 measure H1: per=${per} one alarm run ${(performance.now() - a0).toFixed(1)} ms`,
      );
      // The exact SQL do.ts runs (DELETE_DELIVERED_BODIES_SQL): driven by
      // mail_to; receipts only by primary key, never scanned.
      const plan = await inHub(h, (_, s) =>
        s.storage.sql
          .exec<{ detail: string }>(
            `explain query plan ${DELETE_DELIVERED_BODIES_SQL}`,
            ids[0] as string,
            Number.MAX_SAFE_INTEGER,
            CLOSE_INLINE_BATCH,
          )
          .toArray()
          .map((r) => r.detail),
      );
      console.info(`B11 H1 plan: ${plan.join(" | ")}`);
      expect(plan.some((d) => /USING (COVERING )?INDEX mail_to/.test(d))).toBe(
        true,
      );
      expect(plan.some((d) => /SCAN r\b|SCAN receipts/.test(d))).toBe(false);
      expect(
        plan.some((d) =>
          /SEARCH r USING INDEX sqlite_autoindex_receipts/.test(d),
        ),
      ).toBe(true);
      // Structural bound: the call touches only this agent's body rows. With
      // 2,500 delivered receipts and no bodies, the inner select reads none.
      const touched = await inHub(h, (_, s) =>
        s.storage.sql.exec(
          DELIVERED_BODIES_SELECT_SQL,
          ids[0] as string,
          Number.MAX_SAFE_INTEGER,
          CLOSE_INLINE_BATCH,
        ),
      );
      touched.toArray();
      console.info(
        `B11 H1 rows read by the cleanup select: ${touched.rowsRead}`,
      );
      expect(touched.rowsRead).toBeLessThanOrEqual(CLOSE_INLINE_BATCH + 1);
    }, 300_000);
});

describe("L1 (P5): rowid session bounds", () => {
  it("a same-millisecond close and reopen: the new session's mail is not drained", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("samems");
    const s = await senderOn(h, n);
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u1", "victim", "Victim", n));
    await until(d, "agent_ok");
    const victim = await agentIdOf(h, m.id, "victim");
    const old = await seedReceipts(h, victim, 30, {
      state: "pending",
      body: true,
      now: t0 - 10,
      from: s.id,
    });
    d.send({ v: 1, id: "dn", type: "agent_down", agent_ref: "victim" });
    await sync(d);
    d.send(up("u2", "victim", "Victim", n)); // same frozen ms
    await until(d, "agent_ok");
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
    for (let k = 0; k < 5; k++) await alarmOnce(h);
    const st = await inHub(h, (_, x) =>
      x.storage.sql
        .exec<{ state: string }>(
          "select state from receipts where id = ?",
          fresh.msg_id,
        )
        .one(),
    );
    expect(st.state).toBe("pending");
    for (const id of old)
      expect(
        await count(
          h,
          "select count(*) as n from receipts where id = ? and state = 'expired'",
          id,
        ),
      ).toBe(1);
    // The reopened session can fetch its own new mail but none of the old.
    d.send({
      v: 1,
      id: "f-old",
      type: "fetch",
      from_ref: "victim",
      msg_id: old[0] as string,
    });
    expect(await until(d, "error")).toMatchObject({ code: "not_found" });
  }, 60_000);

  it("the retention purge never deletes the newest receipt, so max(rowid) never goes back", async () => {
    const h = freshHub();
    const now = Date.now();
    const m = await machineOn(h);
    const [a] = await seedAgents(h, m.id, 1, ns("hwm"));
    await inHub(h, (_, s) => {
      for (let i = 0; i < 3; i++)
        s.storage.sql.exec(
          `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, final_at, notified_at)
           values (?, ?, 'seed', ?, 'to', 'nobody', 'from', 'delivered', 1, 0, 1, 1, 1)`,
          newId(),
          OWNER_ORG_ID,
          a as string,
        );
    });
    const max0 = await count(h, "select max(rowid) as n from receipts");
    await clock(h, now + 48 * HOUR);
    // A future real time: an alarm already due would let workerd fire it on
    // its own, racing runDurableObjectAlarm (which then finds none to run).
    await inHub(h, (_, s) => s.storage.setAlarm(Date.now() + HOUR));
    expect(await alarmOnce(h)).toBe(true);
    expect(await count(h, "select count(*) as n from receipts")).toBe(1);
    expect(await count(h, "select max(rowid) as n from receipts")).toBe(max0);
  });
});

describe("L2 (P6): the scrubber redacts JWTs, base64url runs and IPs", () => {
  it("JWT, OIDC code, IPv4, IPv6 and an auth:<ip> key never appear", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const jwt =
      "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiIxMjM0NTY3ODkwIiwiZW1haWwiOiJ4QHkueiJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const code = "4/0AeaYSHDl_Ia0-OoIl0O_aI-0lOl_I0Ol-Ia0lO_I0aOlI";
    logEvent("probe", {
      jwt,
      code,
      ip: "203.0.113.7",
      ip6: "2001:db8::8a2e:370:7334",
      key6: "auth:2001:db8:85a3::8a2e:370:7334",
      key4: "auth:203.0.113.5",
      kind: "rate_limit_unavailable",
    });
    logError(
      "rate_limit_unavailable",
      new Error("limit failed for auth:198.51.100.23"),
    );
    const out = [...spy.mock.calls, ...err.mock.calls]
      .map((c) => String(c[0]))
      .join("\n");
    for (const bad of [
      "eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ",
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      code,
      "0AeaYSHDl_Ia0-OoIl0O_aI",
      "203.0.113.7",
      "2001:db8::8a2e:370:7334",
      "2001:db8:85a3::8a2e:370:7334",
      "8a2e:370:7334",
      "203.0.113.5",
      "198.51.100.23",
    ])
      expect(out).not.toContain(bad);
    // Event names and plain lowercase kinds pass.
    expect(out).toContain('"kind":"rate_limit_unavailable"');
    expect(out).toContain('"evt":"rate_limit_unavailable"');
  });
});

describe("L4: the revoke drain visits only agents with work", () => {
  it("a machine with 2,000 closed idle agents and 1 with mail drains in one step", async () => {
    const h = freshHub();
    const now = Date.now() + HOUR;
    await clock(h, now);
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, 2001, ns("idle"));
    await inHub(h, (_, s) =>
      s.storage.sql.exec(
        "update agents set live = 0 where machine_id = ? and id != ?",
        m.id,
        ids[2000] as string,
      ),
    );
    await seedReceipts(h, ids[2000] as string, 3, {
      state: "pending",
      body: true,
      now: now - 10,
    });
    expect(await h.revokeMachine(m.id)).toBe(true);
    // One step (inside revokeMachine) reaches the agent past 2,000 idle ones.
    expect(
      await count(
        h,
        "select count(*) as n from receipts where state = 'expired' and reason = 'revoked'",
      ),
    ).toBe(3);
  });
});
