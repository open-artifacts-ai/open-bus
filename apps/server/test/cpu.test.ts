// B12 CPU guard: per-call handler round trips on the hub's hot paths, warm,
// median of N, against a named budget each.
//
// OPT-IN: runs only with OB_PERF=1 (like @ob/shared's "decode fast", #54).
// Wall-clock time flakes on shared runners and under the parallel suite, so
// the PR gate never runs it; .github/workflows/perf.yml runs it on a schedule.
// Locally, run it alone on a quiet machine:
//   OB_PERF=1 pnpm --filter @ob/server exec vitest run test/cpu.test.ts
//
// The numbers are wall clock through a real DO socket (frame in, reply out),
// which is an upper bound on handler CPU: the Workers Free budget is ~10 ms of
// CPU per invocation. Each budget below is the median measured on a quiet
// machine times a safety factor of 2 to 3 (see the comment on each); a
// regression of that size is a real algorithmic change, not noise.
import { runInDurableObject } from "cloudflare:test";
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
import { afterAll, describe, expect, it } from "vitest";
import { Hub, type HubStub, SWEEP_BATCH } from "../src/hub/do.js";
import { e, hello, ns, up } from "./helpers.js";

// Forwarded by vitest.config.ts (workerd has no shell env).
declare const __OB_PERF__: boolean;
const PERF = __OB_PERF__;

// ------------------------------------------------------------------ budgets
// Milliseconds, median round trip. Calibrated on a quiet machine (1-minute
// load average < 15, three runs); performance.now() ticks in whole ms inside
// workerd, hence the coarse numbers. Measured medians are in
// docs/superpowers/plans/2026-10-21-openbus/02-backend.md (B12).

/** send, 1 KiB body: receipt back to the sender (insert, deliver, no ack wait). */
const SEND_1K_MS = 10; // measured median 3-4 ms, x2.5
/** send at the inline maximum (32 KiB): the body is copied into deliver. */
const SEND_INLINE_MAX_MS = 10; // measured median 3-4 ms, x2.5
/** agent_up of a new ref: cap check, upsert, roster notify. */
const AGENT_UP_MS = 6; // measured median 2 ms, x3
/** sessions{closed} with 1000 refs, 200 live agents, 10,000 pending (B11 bulk path). */
const SESSIONS_CLOSED_1000_MS = 25; // measured median 7-11 ms, x2.3 of the worst
/** Closing an agent with 500,000 delivered receipts in history (B11 H1: must not scan them). */
const CLOSE_500K_MS = 8; // measured median 2-3 ms, x2.7; an O(history) scan would be orders over
/** Dashboard push at the caps: machines (100) and agents (1000) frames to one dashboard. */
const DASHBOARD_PUSH_CAPS_MS = 22; // measured median 8-9 ms, x2.5 (120 KiB per message)
/** One alarm step with a full SWEEP_BATCH of TTL expiries, sender notified. */
const ALARM_FULL_BATCH_MS = 9; // measured median 3 ms, x3
/** fetch of a 1 MiB (hard max) stored body. */
const FETCH_MAX_MS = 15; // measured median 3-6 ms, x2.5 of the worst
/** hello round trip: the floor under every "send, then sync" measurement. */
const SYNC_BASELINE_MS = 8; // measured median 1-3 ms, x2.7

const HOUR = 3_600_000;
const WARM = 3;

type Row = {
  path: string;
  median: number;
  max: number;
  n: number;
  budget: number;
};
const rows: Row[] = [];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
};

/**
 * Runs `iter` WARM times untimed, then n times; `iter` returns the milliseconds
 * of its timed section (setup stays outside it). Fails with the path name.
 */
async function measure(
  path: string,
  budget: number,
  n: number,
  iter: (i: number) => Promise<number>,
) {
  for (let i = 0; i < WARM; i++) await iter(-1 - i);
  const ms: number[] = [];
  for (let i = 0; i < n; i++) ms.push(await iter(i));
  const m = median(ms);
  rows.push({ path, median: m, max: Math.max(...ms), n, budget });
  expect(
    m,
    `CPU guard "${path}": median ${m.toFixed(2)} ms over budget ${budget} ms (samples ${ms.map((x) => x.toFixed(1)).join(", ")})`,
  ).toBeLessThan(budget);
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

// ------------------------------------------------------------------ plumbing

const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;
const stubOf = (h: HubStub) => h as unknown as DurableObjectStub<Hub>;
const inHub = <R>(h: HubStub, fn: (i: Hub, s: DurableObjectState) => R) =>
  runInDurableObject(stubOf(h), (i: Hub, s) => fn(i, s));
const clock = (h: HubStub, ms: number | null) =>
  inHub(h, (i) => Hub.setTestClock(i, ms));

type D = {
  ws: WebSocket;
  next: () => Promise<ServerFrame>;
  until: <T extends ServerFrame["type"]>(
    t: T,
  ) => Promise<Extract<ServerFrame, { type: T }>>;
  send: (f: ClientFrame) => void;
};

async function daemonOn(h: HubStub, machineId: string): Promise<D> {
  const res = await stubOf(h).fetch("https://hub.internal/hub", {
    headers: { Upgrade: "websocket", "X-Ob-Machine-Id": machineId },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const queue: ServerFrame[] = [];
  const waiting: ((f: ServerFrame) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const t = String(ev.data);
    if (t === PONG) return;
    const r = decodeServerFrame(t);
    expect(r.ok, `not a server frame: ${t}`).toBe(true);
    if (!r.ok) return;
    const w = waiting.shift();
    if (w) w(r.frame);
    else queue.push(r.frame);
  });
  const next = () => {
    const f = queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 20_000);
      waiting.push((x) => {
        clearTimeout(t);
        resolve(x);
      });
    });
  };
  return {
    ws,
    next,
    send: (f) => ws.send(encodeFrame(f)),
    until: async (type) => {
      for (let i = 0; i < 20_000; i++) {
        const f = await next();
        if (f.type === type) return f as never;
      }
      throw new Error(`no ${type}`);
    },
  };
}

async function machineOn(h: HubStub, label = "MacBook") {
  const m = await h.createMachine(label);
  if (!m.ok) throw new Error(m.code);
  return m;
}

/** A connected machine with one registered agent `ref` named `name`. */
async function agentOn(h: HubStub, n: string, name: string) {
  const m = await machineOn(h, name);
  const d = await daemonOn(h, m.id);
  d.send(up(`u-${name}`, name, name, n));
  await d.until("agent_ok");
  const id = inHub(
    h,
    (_, s) =>
      s.storage.sql
        .exec<{ id: string }>(
          "select id from agents where machine_id = ? and native_ref = ?",
          m.id,
          name,
        )
        .one().id,
  );
  return { d, m, id: await id };
}

/** Round-trips a hello, so every frame sent before it has been handled. */
async function sync(d: D) {
  const id = `sync-${newId()}`;
  d.send(hello(id));
  for (;;) {
    const f = await d.next();
    if (f.type === "hello_ok" && f.id === id) return;
  }
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

/** `per` rows 0..per-1 as a CTE subquery, for set-based seeding. */
const SERIES = (per: number) =>
  `(with recursive c(i) as (select 0 union all select i + 1 from c where i < ${per - 1}) select i from c)`;

// -------------------------------------------------------------------- tests

describe.skipIf(!PERF)("B12 CPU guard (OB_PERF=1)", () => {
  afterAll(() => {
    const w = Math.max(...rows.map((r) => r.path.length), 4);
    const line = (a: string, b: string, c: string, d: string, e2: string) =>
      `${a.padEnd(w)}  ${b.padStart(10)}  ${c.padStart(10)}  ${d.padStart(10)}  ${e2.padStart(4)}`;
    console.info(
      [
        "",
        "B12 CPU guard, wall-clock round trip per call (ms)",
        line("path", "median", "max", "budget", "n"),
        ...rows.map((r) =>
          line(
            r.path,
            r.median.toFixed(2),
            r.max.toFixed(2),
            String(r.budget),
            String(r.n),
          ),
        ),
        "",
      ].join("\n"),
    );
  });

  it("hello round trip (baseline)", async () => {
    const h = freshHub();
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await measure("hello baseline", SYNC_BASELINE_MS, 25, () =>
      timed(() => sync(d)),
    );
  });

  for (const [label, bytes, budget] of [
    ["send 1 KiB", 1024, SEND_1K_MS],
    ["send inline max (32 KiB)", LIMITS.inlineBodyBytes, SEND_INLINE_MAX_MS],
  ] as const)
    it(label, async () => {
      const h = freshHub();
      const n = ns("send");
      const s = await agentOn(h, n, "Sender");
      const r = await agentOn(h, n, "Rcpt");
      const body = "x".repeat(bytes);
      await measure(label, budget, 25, async (i) => {
        const id = `s${i}`;
        const ms = await timed(async () => {
          s.d.send({
            v: 1,
            id,
            type: "send",
            from_ref: "Sender",
            to_name: "Rcpt",
            body,
          });
          await s.d.until("receipt");
        });
        // The recipient acks outside the timed section (inbox stays empty).
        const dv = await r.d.until("deliver");
        r.d.send({ v: 1, id: `a${i}`, type: "ack", msg_id: dv.msg_id });
        return ms;
      });
    }, 60_000);

  it("agent_up", async () => {
    const h = freshHub();
    const n = ns("up");
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    await measure("agent_up", AGENT_UP_MS, 25, async (i) => {
      const ref = `ref-${i}`;
      return timed(async () => {
        d.send(up(`u${i}`, ref, `Agent${i + 10}`, n));
        await d.until("agent_ok");
      });
    });
  }, 60_000);

  it("sessions{closed} with 1000 refs", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("sc");
    const m = await machineOn(h);
    const ids = await seedAgents(h, m.id, LIMITS.maxAgentsPerMachine, n);
    const d = await daemonOn(h, m.id);
    await sync(d);
    // 200 live refs plus 800 unknown ones: the 1000-ref cap.
    const closed = [
      ...ids.map((_, i) => `seed_${i}`),
      ...Array.from({ length: 800 }, (_, i) => `ghost_${i}`),
    ];
    expect(closed.length).toBe(LIMITS.maxRosterAgents);
    await measure(
      "sessions{closed} 1000 refs",
      SESSIONS_CLOSED_1000_MS,
      11,
      async (i) => {
        const stamp = t0 + i + 10; // unique per iteration and warm-up
        await inHub(h, (_, s) => {
          const sql = s.storage.sql;
          sql.exec("update agents set live = 1");
          // inboxCap pending to each live agent, with a stored body each: 10,000.
          sql.exec(
            `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
           select a.id || '-' || c.i || '-' || ?1, ?2, 'seed', a.id, 'to', 'nobody', 'from', 'pending', ?3, ?4, ?5
           from agents a, ${SERIES(LIMITS.inboxCap)} c where a.live = 1`,
            stamp,
            OWNER_ORG_ID,
            LIMITS.inlineBodyBytes + 1,
            stamp,
            t0 + HOUR,
          );
          sql.exec(
            `insert into mail (id, org_id, to_agent, body, created_at, expires_at)
           select id, org_id, to_agent, 'b', created_at, expires_at from receipts where created_at = ?`,
            stamp,
          );
        });
        return timed(async () => {
          d.send({ v: 1, id: `c${i}`, type: "sessions", open: [], closed });
          await sync(d);
        });
      },
    );
  }, 300_000);

  it("close with 500k delivered receipts in history", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("h1");
    const m = await machineOn(h);
    const d = await daemonOn(h, m.id);
    d.send(up("u0", "victim", "Victim", n));
    await d.until("agent_ok");
    const victim = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ id: string }>(
            "select id from agents where native_ref = 'victim'",
          )
          .one().id,
    );
    await inHub(h, (_, s) => {
      const sql = s.storage.sql;
      // 500,000 = 500 x 1000, final and already told: history the close must not scan.
      sql.exec(
        `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, final_at, notified_at)
         select 'h-' || a.i || '-' || b.i, ?1, 'seed', ?2, 'to', 'nobody', 'from', 'delivered', 10, ?3, ?4, ?3, ?3, ?3
         from ${SERIES(500)} a, ${SERIES(1000)} b`,
        OWNER_ORG_ID,
        victim,
        t0 - 1000,
        t0 + HOUR,
      );
      // 1000 of them still hold a stored notice body, so the delete path has work.
      sql.exec(
        `insert into mail (id, org_id, to_agent, body, created_at, expires_at)
         select id, org_id, to_agent, 'b', created_at, expires_at from receipts where id like 'h-0-%'`,
      );
    });
    expect(
      await inHub(
        h,
        (_, s) =>
          s.storage.sql
            .exec<{ n: number }>("select count(*) as n from receipts")
            .one().n,
      ),
    ).toBe(500_000);
    await measure("close, 500k delivered", CLOSE_500K_MS, 15, async (i) => {
      d.send(up(`r${i}`, "victim", "Victim", n));
      await d.until("agent_ok");
      return timed(async () => {
        d.send({ v: 1, id: `dn${i}`, type: "agent_down", agent_ref: "victim" });
        await sync(d);
      });
    });
  }, 600_000);

  it("dashboard push at the caps (100 machines, 1000 agents)", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("dash");
    const first = await machineOn(h, "M0");
    for (let k = 1; k < LIMITS.maxMachinesListed; k++) {
      const m = await machineOn(h, `M${k}`);
      await seedAgents(h, m.id, 10, n);
    }
    await seedAgents(h, first.id, 9, n); // 99*10 + 9 = 999, plus the real one below
    const d = await daemonOn(h, first.id);
    d.send(up("u0", "flip", "Flip", n));
    await d.until("agent_ok");
    const total = await inHub(
      h,
      (_, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from agents where live = 1",
          )
          .one().n,
    );
    expect(total).toBe(LIMITS.maxRosterAgents);

    const res = await stubOf(h).fetch(`https://hub.internal${EVENTS_DO_PATH}`, {
      headers: {
        Upgrade: "websocket",
        [SESSION_EXP_HEADER]: String(Date.now() + 24 * HOUR),
        [SESSION_GEN_HEADER]: "0",
      },
    });
    expect(res.status).toBe(101);
    const dash = res.webSocket as WebSocket;
    dash.accept();
    let got = 0;
    let bytes = 0;
    let wake: (() => void) | null = null;
    dash.addEventListener("message", (ev) => {
      got++;
      bytes += String(ev.data).length;
      wake?.();
    });
    const waitMessages = async (k: number) => {
      const want = got + k;
      while (got < want)
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 20_000);
        });
    };
    await waitMessages(0);
    let step = 0;
    await measure(
      "dashboard push (100m/1000a)",
      DASHBOARD_PUSH_CAPS_MS,
      15,
      async () => {
        // Past the 500 ms throttle window each time, so the push is immediate.
        await clock(h, t0 + ++step * 2000);
        const start = got;
        const ms = await timed(async () => {
          d.send({
            v: 1,
            id: `dn${step}`,
            type: "agent_down",
            agent_ref: "flip",
          });
          while (got < start + 2)
            await new Promise<void>((r) => {
              wake = r;
              setTimeout(r, 20_000);
            });
        });
        await clock(h, t0 + ++step * 2000);
        const s2 = got;
        d.send(up(`up${step}`, "flip", "Flip", n));
        await d.until("agent_ok");
        while (got < s2 + 2)
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 20_000);
          });
        return ms;
      },
    );
    console.info(
      `dashboard push payload: ${(bytes / got / 1024).toFixed(0)} KiB avg per message`,
    );
  }, 300_000);

  it("alarm step with a full SWEEP_BATCH", async () => {
    const h = freshHub();
    const t0 = Date.now() + HOUR;
    await clock(h, t0);
    const n = ns("alarm");
    const s = await agentOn(h, n, "Sender");
    const r = await agentOn(h, n, "Rcpt");
    await measure(
      "alarm, full SWEEP_BATCH",
      ALARM_FULL_BATCH_MS,
      15,
      async (i) => {
        const stamp = t0 - 100_000 + i; // unique per iteration and warm-up
        await inHub(h, (_, x) => {
          const sql = x.storage.sql;
          // Ids are real msg ids: the sender's socket gets a receipt_update each.
          for (let k = 0; k < SWEEP_BATCH; k++) {
            const id = newId();
            sql.exec(
              `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at)
               values (?, ?, ?, ?, 'Rcpt', ?, 'Sender', 'pending', ?, ?, ?)`,
              id,
              OWNER_ORG_ID,
              n,
              r.id,
              s.id,
              LIMITS.inlineBodyBytes + 1,
              stamp,
              t0 - 1,
            );
            sql.exec(
              "insert into mail (id, org_id, to_agent, body, created_at, expires_at) values (?, ?, ?, 'b', ?, ?)",
              id,
              OWNER_ORG_ID,
              r.id,
              stamp,
              t0 - 1,
            );
          }
        });
        return timed(async () => {
          await inHub(h, (hub) => hub.alarm());
        });
      },
    );
  }, 120_000);

  it("fetch of a 1 MiB body", async () => {
    const h = freshHub();
    const n = ns("fetch");
    const s = await agentOn(h, n, "Sender");
    const r = await agentOn(h, n, "Rcpt");
    const body = "y".repeat(LIMITS.maxMessageBytes);
    await measure("fetch 1 MiB", FETCH_MAX_MS, 11, async (i) => {
      s.d.send({
        v: 1,
        id: `s${i}`,
        type: "send",
        from_ref: "Sender",
        to_name: "Rcpt",
        body,
      });
      const dv = await r.d.until("deliver");
      expect(dv.notice?.size).toBe(LIMITS.maxMessageBytes);
      return timed(async () => {
        r.d.send({
          v: 1,
          id: `f${i}`,
          type: "fetch",
          from_ref: "Rcpt",
          msg_id: dv.msg_id,
        });
        await r.d.until("body");
      });
    });
  }, 120_000);
});
