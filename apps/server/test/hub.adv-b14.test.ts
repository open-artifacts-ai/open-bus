// Adversarial probes for B14 (idempotent send), ported from adv-B14 with the
// fix-round-1 rulings: P3 (cap eviction never drops a pending key: one
// deliver, rate_limited at the cap), P5 (own namespace explicit == absent),
// P9 (hub-wide SEND_KEYS_TOTAL cap).
import { runInDurableObject } from "cloudflare:test";
import { type ClientFrame, LIMITS, type ServerFrame } from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  Hub,
  SEND_KEYS_MESSAGE,
  SEND_KEYS_PER_AGENT,
  SEND_KEYS_TOTAL,
} from "../src/hub/do.js";
import { hub } from "../src/hub/stub.js";
import {
  type Daemon,
  e,
  framesSeen,
  hello,
  inOwnerHub,
  machine,
  ns,
  ready,
  up,
  waitFor,
} from "./helpers.js";

const stub = () => hub(e) as unknown as DurableObjectStub<Hub>;
const inHub = <R>(fn: (i: Hub, s: DurableObjectState) => R) =>
  runInDurableObject(stub(), fn);
const setClock = (ms: number | null) => inHub((i) => Hub.setTestClock(i, ms));
afterEach(async () => {
  await setClock(null);
  await inHub((i) => Hub.setSendKeysTotalForTests(i, null));
});

type Receipt = Extract<ServerFrame, { type: "receipt" }>;
type ErrorF = Extract<ServerFrame, { type: "error" }>;
let seq = 0;
const uniq = (t: string) => `${t}-${++seq}x${Date.now() % 1e8}`;
const send = (
  id: string,
  from_ref: string,
  to_name: string,
  body = "hello",
  to_namespace?: string,
): ClientFrame =>
  (to_namespace === undefined
    ? { v: 1, id, type: "send", from_ref, to_name, body }
    : {
        v: 1,
        id,
        type: "send",
        from_ref,
        to_name,
        to_namespace,
        body,
      }) as ClientFrame;

async function agent(d: Daemon, ref: string, name: string, n: string) {
  d.send(up(`u-${ref}-${++seq}`, ref, name, n));
  expect((await waitFor(d, "agent_ok")).bus_name).toBe(name);
}
async function barrier(d: Daemon) {
  const id = `b${++seq}`;
  d.send(hello(id));
  for (;;) if ((await waitFor(d, "hello_ok")).id === id) return;
}
async function reply(d: Daemon, f: ClientFrame): Promise<Receipt | ErrorF> {
  d.send(f);
  for (;;) {
    const r = await d.next();
    if ((r.type === "receipt" || r.type === "error") && r.id === f.id) return r;
  }
}
const delivers = (d: Daemon) =>
  framesSeen(d).filter((f) => f.type === "deliver");
async function offline(d: Daemon) {
  d.close();
  await d.closed;
  await new Promise((r) => setTimeout(r, 50));
}

describe("adv B14", () => {
  it("P1 query plans: find, cap count, cap delete and sweep are indexed", async () => {
    const plans = await inOwnerHub((s) => {
      const q = (x: string, ...b: unknown[]) =>
        s.storage.sql
          .exec<{ detail: string }>(
            `explain query plan ${x}`,
            ...(b as never[]),
          )
          .toArray()
          .map((r) => r.detail)
          .join(" | ");
      return {
        find: q(
          "select payload_hash, msg_id, created_at from send_keys where from_agent = ? and frame_id = ?",
          "a",
          "f",
        ),
        count: q(
          "select count(*) as n from (select 1 from send_keys where from_agent = ? limit ?)",
          "a",
          201,
        ),
        evictAgent: q(
          `select k.rowid as k from send_keys k indexed by send_keys_agent
  left join receipts r on r.id = k.msg_id
  where k.from_agent = ? and (r.id is null or r.state != 'pending')
  order by k.rowid limit 1`,
          "a",
        ),
        evictHub: q(
          `select k.rowid as k from (select rowid, msg_id from send_keys order by rowid limit ?) k
  left join receipts r on r.id = k.msg_id
  where r.id is null or r.state != 'pending'
  order by k.rowid limit 1`,
          200,
        ),
        sweep: q(
          "delete from send_keys where rowid in (select rowid from send_keys where created_at < ? limit ?) returning rowid",
          0,
          50,
        ),
        next: q("select min(created_at) as t from send_keys"),
      };
    });
    console.log("PLANS", JSON.stringify(plans, null, 1));
    const { evictHub, ...rest } = plans;
    for (const p of Object.values(rest))
      expect(p).not.toMatch(/SCAN send_keys(?! USING)/);
    expect(plans.evictAgent).not.toMatch(/TEMP B-TREE/);
    expect(plans.evictAgent).toMatch(/SEARCH r USING/);
    // The hub-wide walk is the table in rowid order, cut by its limit.
    expect(evictHub).not.toMatch(/TEMP B-TREE/);
    expect(evictHub).toMatch(/SEARCH r USING/);
  });

  it("P2 offline recipient: resends before and after the flush never deliver twice", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r1.state).toBe("pending");
    // Two resends in the same burst (same DO turn ordering).
    s.send(send("k1", "sref", rcv));
    s.send(send("k1", "sref", rcv));
    await barrier(s);
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    const d = await waitFor(t, "deliver");
    expect(d.msg_id).toBe(r1.msg_id);
    // Resend after the flush, before the ack: pending, no second deliver.
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
    await waitFor(s, "receipt_update");
    const r3 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r3.msg_id).toBe(r1.msg_id);
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "delivered",
    });
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P3 at the per-agent cap with every key pending: rate_limited, and the original still dedupes (one deliver)", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14cap");
    const sender = uniq("Snd");
    await agent(s, "sref", sender, n);
    const rcvs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = uniq(`R${i}`);
      rcvs.push(r);
      await agent(t, `r${i}`, r, n);
    }
    await offline(t);
    // Original goes to R0 and stays pending (R0 offline).
    const first = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    expect(first.state).toBe("pending");
    // 199 more accepted sends: the agent holds SEND_KEYS_PER_AGENT pending keys.
    for (let i = 0; i < SEND_KEYS_PER_AGENT - 1; i++) {
      const to = rcvs[1 + (i % 4)] as string;
      const r = (await reply(s, send(`f${i}`, "sref", to, "x"))) as Receipt;
      expect(r.state).toBe("pending");
    }
    const sid = await inOwnerHub(
      (st) =>
        st.storage.sql
          .exec<{ id: string }>(
            "select id from agents where machine_id = ? and native_ref = 'sref'",
            sm.id,
          )
          .one().id,
    );
    const counts = () =>
      inOwnerHub((st) => ({
        keys: st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from send_keys where from_agent = ?",
            sid,
          )
          .one().n,
        receipts: st.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from receipts where from_agent = ?",
            sid,
          )
          .one().n,
      }));
    // No final key to evict: the next new send is rate_limited, nothing stored.
    const over = await reply(s, send("over", "sref", rcvs[4] as string, "x"));
    expect(over).toEqual({
      v: 1,
      id: "over",
      type: "error",
      code: "rate_limited",
      message: SEND_KEYS_MESSAGE,
    });
    expect(await counts()).toEqual({
      keys: SEND_KEYS_PER_AGENT,
      receipts: SEND_KEYS_PER_AGENT,
    });
    // The daemon resends the original (a lost connection): still deduped.
    const again = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    expect(again).toMatchObject({ msg_id: first.msg_id, state: "pending" });
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["r0"], closed: [] });
    await agent(t, "r0", rcvs[0] as string, n);
    const d = await waitFor(t, "deliver");
    expect(d.msg_id).toBe(first.msg_id);
    await barrier(t);
    const ds = delivers(t).filter(
      (f) => f.type === "deliver" && "body" in f && f.body === "dup-me",
    );
    expect(ds.length).toBe(1);
    // Once one send is final, the oldest final key (orig) makes room.
    t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
    await waitFor(s, "receipt_update");
    const ok = (await reply(
      s,
      send("over", "sref", rcvs[4] as string, "x"),
    )) as Receipt;
    expect(ok.state).toBe("pending");
    expect((await counts()).keys).toBe(SEND_KEYS_PER_AGENT);
    const orig = (await reply(
      s,
      send("orig", "sref", rcvs[0] as string, "dup-me"),
    )) as Receipt;
    // orig's key was the one evicted (final): it is a new send now.
    expect(orig.msg_id).not.toBe(first.msg_id);
    s.close();
    t.close();
  }, 60_000);

  it("P4 sender closes and reopens (agent_down, agent_up same ref): key persists", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n = ns("adv14re");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    await waitFor(t, "deliver");
    s.send({
      v: 1,
      id: "dn",
      type: "agent_down",
      agent_ref: "sref",
    } as ClientFrame);
    await barrier(s);
    await agent(s, "sref", sender, n);
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    console.log("P4", r1.msg_id, r2.msg_id);
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P5 absent to_namespace vs the sender's own namespace (same target) is the same payload", async () => {
    const sm = await machine("S");
    const s = await ready(sm.token);
    const tm = await machine("T");
    const t = await ready(tm.token);
    const n = ns("adv14ns");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    const r1 = await reply(s, send("k1", "sref", rcv));
    expect(r1.type).toBe("receipt");
    const r2 = await reply(s, send("k1", "sref", rcv, "hello", n));
    expect(r2).toEqual(r1);
    // And the other way round: explicit first, absent on the resend.
    const r3 = await reply(s, send("k2", "sref", rcv, "hello", n));
    const r4 = await reply(s, send("k2", "sref", rcv));
    expect(r4).toEqual(r3);
    await barrier(t);
    expect(delivers(t)).toHaveLength(2);
    s.close();
    t.close();
  });

  it("P6 recipient machine revoked while pending: resend reports expired, delivers nothing", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n = ns("adv14rv");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(await hub(e).revokeMachine(tm.id)).toBe(true);
    await waitFor(s, "receipt_update");
    const r2 = (await reply(s, send("k1", "sref", rcv))) as Receipt;
    expect(r2).toMatchObject({ msg_id: r1.msg_id, state: "pending" });
    expect(await waitFor(s, "receipt_update")).toMatchObject({
      msg_id: r1.msg_id,
      state: "expired",
      reason: "recipient_closed",
    });
    s.close();
  });

  it("P7 sender re-registers into another namespace: absent-ns resend dedupes to the old target", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    const t = await ready(tm.token);
    const n1 = ns("adv14a");
    const n2 = ns("adv14b");
    const sender = uniq("Snd");
    const bob = uniq("Bob");
    await agent(s, "sref", sender, n1);
    await agent(t, "b1", bob, n1);
    await agent(t, "b2", bob, n2);
    const r1 = (await reply(s, send("k1", "sref", bob))) as Receipt;
    await waitFor(t, "deliver");
    await agent(s, "sref", sender, n2);
    const r2 = (await reply(s, send("k1", "sref", bob))) as Receipt;
    console.log("P7", r1.msg_id, r2.msg_id, r2.state);
    expect(r2.msg_id).toBe(r1.msg_id);
    await barrier(t);
    expect(delivers(t)).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P8 unswept stale key (> 2 h, alarm not run) while the receipt is still pending: one deliver", async () => {
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14st");
    const sender = uniq("Snd");
    const rcv = uniq("Rcv");
    await agent(s, "sref", sender, n);
    await agent(t, "rref", rcv, n);
    await offline(t);
    const r1 = (await reply(s, send("k1", "sref", rcv, "stale"))) as Receipt;
    await setClock(Date.now() + 2 * LIMITS.mailTtlSec * 1000 + 5000);
    const r2 = (await reply(s, send("k1", "sref", rcv, "stale"))) as Receipt;
    console.log("P8", r1.msg_id, r2.msg_id, r2.state);
    expect(r2.msg_id).not.toBe(r1.msg_id);
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    await barrier(t);
    const ds = delivers(t);
    console.log("P8 delivers", ds.length);
    expect(ds).toHaveLength(1);
    s.close();
    t.close();
  });

  it("P9 hub-wide cap: ref churn cannot multiply the per-agent cap past SEND_KEYS_TOTAL", async () => {
    expect(SEND_KEYS_TOTAL).toBe(20_000);
    const sm = await machine("S");
    const tm = await machine("T");
    const s = await ready(sm.token);
    let t = await ready(tm.token);
    const n = ns("adv14ch");
    const rcv = uniq("Rcv");
    await agent(t, "rref", rcv, n);
    await offline(t);
    const total = () =>
      inOwnerHub(
        (st) =>
          st.storage.sql
            .exec<{ n: number }>("select count(*) as n from send_keys")
            .one().n,
      );
    // A clean slate and a small hub-wide cap (the rule, not the number).
    await inOwnerHub((st) => st.storage.sql.exec("delete from send_keys"));
    const CAP = 6;
    await inHub((i) => Hub.setSendKeysTotalForTests(i, CAP));
    // Three refs (churned agents), two pending sends each: the hub is full.
    const ids: Receipt[] = [];
    for (let r = 0; r < 3; r++) {
      const ref = `churn${r}`;
      await agent(s, ref, uniq("C"), n);
      for (let i = 0; i < 2; i++) {
        const x = (await reply(
          s,
          send(`c${r}-${i}`, ref, rcv, `x${r}${i}`),
        )) as Receipt;
        expect(x.state).toBe("pending");
        ids.push(x);
      }
      s.send({
        v: 1,
        id: `d${r}`,
        type: "agent_down",
        agent_ref: ref,
      } as ClientFrame);
    }
    await barrier(s);
    expect(await total()).toBe(CAP);
    // A fresh ref: every key hub-wide is pending, so rate_limited.
    await agent(s, "churn9", uniq("C"), n);
    const over = await reply(s, send("c9", "churn9", rcv, "y"));
    expect(over).toMatchObject({
      type: "error",
      code: "rate_limited",
      message: SEND_KEYS_MESSAGE,
    });
    expect(await total()).toBe(CAP);
    // The recipient acks one (the second oldest): only that final key goes.
    t = await ready(tm.token);
    t.send({ v: 1, id: "se", type: "sessions", open: ["rref"], closed: [] });
    await agent(t, "rref", rcv, n);
    const target = (ids[1] as Receipt).msg_id;
    for (;;) {
      const d = await waitFor(t, "deliver");
      if (d.msg_id === target) {
        t.send({ v: 1, id: "a1", type: "ack", msg_id: d.msg_id });
        break;
      }
    }
    await waitFor(s, "receipt_update");
    const ok = (await reply(s, send("c9", "churn9", rcv, "y"))) as Receipt;
    expect(ok.state).toBe("pending");
    expect(await total()).toBe(CAP);
    const gone = await inOwnerHub((st) =>
      st.storage.sql
        .exec<{ msgId: string }>("select msg_id as msgId from send_keys")
        .toArray()
        .map((r) => r.msgId),
    );
    expect(gone).not.toContain(target);
    expect(gone).toContain((ids[0] as Receipt).msg_id);
    s.close();
    t.close();
  });
});
