import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Receipts, SentStore } from "../src/sent.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");
const meta = { from_ref: "s1", to_name: "peer", namespace: "ns" };
const ID = "mmmmmmmmmmmmmmm1";

describe("SentStore", () => {
  it("survives a restart, 0600, until deleted", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, meta);
    s.flush();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const next = new SentStore(f);
    expect(next.get(ID)).toEqual(meta);
    next.delete(ID);
    expect(next.get(ID)).toBeUndefined();
    next.flush();
    expect(new SentStore(f).get(ID)).toBeUndefined();
  });

  it("keeps the excerpt across a restart, and still loads an entry without one", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, { ...meta, excerpt: "Can you regenerate…" });
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.flush();
    const next = new SentStore(f);
    expect(next.get(ID)).toEqual({ ...meta, excerpt: "Can you regenerate…" });
    expect(next.get("mmmmmmmmmmmmmmm2")).toEqual(meta);
  });

  it("drops a stored excerpt that could break the quoting", () => {
    const f = file();
    const at = Date.now();
    writeFileSync(
      f,
      JSON.stringify({
        [ID]: { ...meta, at, excerpt: 'a "b"' },
        mmmmmmmmmmmmmmm2: { ...meta, at, excerpt: "a\nb" },
        mmmmmmmmmmmmmmm3: { ...meta, at, excerpt: 7 },
      }),
    );
    const s = new SentStore(f);
    for (const id of [ID, "mmmmmmmmmmmmmmm2", "mmmmmmmmmmmmmmm3"])
      expect(s.get(id)).toEqual(meta);
  });

  it("keeps an untold outcome across a restart", () => {
    const f = file();
    const s = new SentStore(f);
    s.add(ID, meta);
    s.settle(ID, { state: "expired", reason: "recipient_closed" });
    s.flush();
    expect(new SentStore(f).untold("s1")).toEqual([
      {
        msgId: ID,
        meta,
        outcome: { state: "expired", reason: "recipient_closed" },
      },
    ]);
    expect(new SentStore(f).untold("other")).toEqual([]);
  });

  it("an owed notice lives a full TTL from when its outcome settled", () => {
    let t = 0;
    const s = new SentStore(file(), { ttlMs: 65 * 60_000, now: () => t });
    s.add(ID, meta);
    t = 60 * 60_000;
    s.settle(ID, { state: "expired" });
    t = 120 * 60_000;
    expect(s.untold("s1")).toEqual([
      { msgId: ID, meta, outcome: { state: "expired" } },
    ]);
    t = 126 * 60_000;
    expect(s.untold("s1")).toEqual([]);
  });

  it("batches writes: one per tick, however many changes", async () => {
    const f = file();
    const s = new SentStore(f);
    for (let i = 1; i <= 9; i++) s.add(`mmmmmmmmmmmmmmm${i}`, meta);
    s.delete("mmmmmmmmmmmmmmm9");
    expect(() => statSync(f)).toThrow();
    await new Promise((r) => setImmediate(r));
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")))).toHaveLength(8);
  });

  it("forgets entries past the TTL and prunes them from disk", () => {
    const f = file();
    let t = 0;
    const s = new SentStore(f, { ttlMs: 1000, now: () => t });
    s.add(ID, meta);
    t = 2000;
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.flush();
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")))).toEqual([
      "mmmmmmmmmmmmmmm2",
    ]);
    expect(
      new SentStore(f, { ttlMs: 1000, now: () => t }).get(ID),
    ).toBeUndefined();
  });

  it("keeps at most max entries, dropping the oldest", () => {
    let t = 0;
    const s = new SentStore(file(), { max: 2, now: () => ++t });
    s.add("mmmmmmmmmmmmmmm1", meta);
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.add("mmmmmmmmmmmmmmm3", meta);
    expect(s.get("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm3")).toEqual(meta);
  });

  it("ignores a corrupt or hostile file", () => {
    const f = file();
    writeFileSync(
      f,
      JSON.stringify({
        __proto__: { from_ref: "x" },
        "bad id": { ...meta, at: Date.now() },
        mmmmmmmmmmmmmmm1: {
          from_ref: "bad ref/..",
          to_name: "p",
          at: Date.now(),
        },
        mmmmmmmmmmmmmmm2: { ...meta, at: "now" },
        mmmmmmmmmmmmmmm3: { ...meta, at: Date.now(), outcome: { state: "x" } },
      }),
    );
    const s = new SentStore(f);
    expect(s.get("bad id")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm2")).toBeUndefined();
    expect(s.get("mmmmmmmmmmmmmmm3")).toBeUndefined();
    writeFileSync(f, "{not json");
    expect(new SentStore(f).get(ID)).toBeUndefined();
  });

  it("logs a failed write and keeps serving from memory", () => {
    const log = vi.fn();
    const s = new SentStore(join(file(), "missing-dir", "sent.json"), { log });
    s.add(ID, meta);
    s.flush();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/sent file write failed/),
    );
    expect(s.get(ID)).toEqual(meta);
  });
});

describe("Receipts", () => {
  const hi = { ...meta, excerpt: "hi" };
  const send = (id: string) => ({
    v: 1 as const,
    id,
    type: "send" as const,
    from_ref: "s1",
    to_name: "peer",
    body: "hi",
  });

  it("tells a native sender of a refusal at once; a tool call reads its own", () => {
    const r = new Receipts(new SentStore());
    r.sending(send("f1"), "ns", true);
    r.sending(send("f2"), "ns", false);
    const refused = (id: string) =>
      r.receipt({ id, msg_id: ID, state: "refused", reason: "too_large" });
    expect(refused("f1")).toEqual({
      msgId: ID,
      meta: hi,
      state: "refused",
      reason: "too_large",
    });
    expect(refused("f2")).toBeUndefined();
    expect(refused("f3")).toBeUndefined();
  });

  it("forgets a send whose receipt never came, or that the hub answered with an error", () => {
    let t = 0;
    const r = new Receipts(new SentStore(), { now: () => t });
    r.sending(send("f1"), "ns", true);
    r.sending(send("f3"), "ns", true);
    r.forget("f3");
    expect(
      r.receipt({ id: "f3", msg_id: ID, state: "refused", reason: "closed" }),
    ).toBeUndefined();
    t = 16 * 60_000;
    r.sending(send("f2"), "ns", true);
    expect(
      r.receipt({ id: "f1", msg_id: ID, state: "refused", reason: "closed" }),
    ).toBeUndefined();
  });

  it("an update that beats its receipt is applied when the receipt comes, within 60 s", () => {
    let t = 0;
    const r = new Receipts(new SentStore(), { now: () => t });
    r.sending(send("f1"), "ns", false);
    expect(r.update({ msg_id: ID, state: "expired" })).toBeUndefined();
    expect(r.receipt({ id: "f1", msg_id: ID, state: "pending" })).toEqual({
      msgId: ID,
      meta: hi,
      state: "expired",
    });
    const late = "mmmmmmmmmmmmmmm2";
    r.sending(send("f2"), "ns", false);
    r.update({ msg_id: late, state: "expired" });
    t = 61_000;
    expect(
      r.receipt({ id: "f2", msg_id: late, state: "pending" }),
    ).toBeUndefined();
  });

  it("keeps a notice owed until told", () => {
    const r = new Receipts(new SentStore());
    r.sending(send("f1"), "ns", false);
    r.receipt({ id: "f1", msg_id: ID, state: "pending" });
    r.update({ msg_id: ID, state: "refused", reason: "closed" });
    expect(r.owed("s1")).toEqual([
      { msgId: ID, meta: hi, state: "refused", reason: "closed" },
    ]);
    r.told(ID);
    expect(r.owed("s1")).toEqual([]);
  });
});
