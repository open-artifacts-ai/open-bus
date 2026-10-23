import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Receipts, SentStore } from "../src/sent.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "ob-sent-")), "sent.json");
const meta = { from_ref: "s1", to_name: "peer", namespace: "ns" };
const ID = "mmmmmmmmmmmmmmm1";

describe("SentStore", () => {
  it("survives a restart, 0600, and is taken once", () => {
    const f = file();
    new SentStore(f).add(ID, meta);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const next = new SentStore(f);
    expect(next.take(ID)).toEqual(meta);
    expect(next.take(ID)).toBeUndefined();
    expect(new SentStore(f).take(ID)).toBeUndefined();
  });

  it("forgets entries past the TTL and prunes them from disk", () => {
    const f = file();
    let t = 0;
    const s = new SentStore(f, { ttlMs: 1000, now: () => t });
    s.add(ID, meta);
    t = 2000;
    s.add("mmmmmmmmmmmmmmm2", meta);
    expect(Object.keys(JSON.parse(readFileSync(f, "utf8")))).toEqual([
      "mmmmmmmmmmmmmmm2",
    ]);
    expect(new SentStore(f, { ttlMs: 1000, now: () => t }).take(ID)).toBe(
      undefined,
    );
  });

  it("keeps at most max entries, dropping the oldest", () => {
    let t = 0;
    const s = new SentStore(file(), { max: 2, now: () => ++t });
    s.add("mmmmmmmmmmmmmmm1", meta);
    s.add("mmmmmmmmmmmmmmm2", meta);
    s.add("mmmmmmmmmmmmmmm3", meta);
    expect(s.take("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.take("mmmmmmmmmmmmmmm3")).toEqual(meta);
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
      }),
    );
    const s = new SentStore(f);
    expect(s.take("bad id")).toBeUndefined();
    expect(s.take("mmmmmmmmmmmmmmm1")).toBeUndefined();
    expect(s.take("mmmmmmmmmmmmmmm2")).toBeUndefined();
    writeFileSync(f, "{not json");
    expect(new SentStore(f).take(ID)).toBeUndefined();
  });
});

describe("SentStore disk errors", () => {
  it("logs a failed write and keeps serving from memory", () => {
    const log = vi.fn();
    const s = new SentStore(join(file(), "missing-dir", "sent.json"), { log });
    s.add(ID, meta);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/sent file write failed/),
    );
    expect(s.take(ID)).toEqual(meta);
  });
});

describe("Receipts", () => {
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
      meta,
      state: "refused",
      reason: "too_large",
    });
    expect(refused("f2")).toBeUndefined();
    expect(refused("f3")).toBeUndefined();
  });

  it("forgets a send whose receipt never came", () => {
    let t = 0;
    const r = new Receipts(new SentStore(), { now: () => t });
    r.sending(send("f1"), "ns", true);
    t = 16 * 60_000;
    r.sending(send("f2"), "ns", true);
    expect(
      r.receipt({ id: "f1", msg_id: ID, state: "refused", reason: "closed" }),
    ).toBeUndefined();
  });
});
