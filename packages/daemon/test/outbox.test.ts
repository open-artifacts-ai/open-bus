import { describe, expect, it, vi } from "vitest";
import { Outbox } from "../src/outbox.ts";

describe("outbox", () => {
  it("sends at once while the hub is up", () => {
    const send = vi.fn(() => true);
    const o = new Outbox<string>({ send });
    o.push("a");
    expect(send).toHaveBeenCalledWith("a");
    expect(o.size).toBe(0);
  });

  it("queues while the hub is down and flushes in order", () => {
    let up = false;
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
    });
    o.push("a");
    o.push("b");
    expect(o.size).toBe(2);
    up = true;
    o.flush();
    expect(sent).toEqual(["a", "b"]);
    expect(o.size).toBe(0);
  });

  it("keeps the rest queued when the link drops mid-flush", () => {
    let budget = 0;
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (budget <= 0) return false;
        budget -= 1;
        sent.push(f);
        return true;
      },
    });
    o.push("a");
    o.push("b");
    o.push("c");
    budget = 1;
    o.flush();
    budget = 5;
    o.flush();
    expect(sent).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest past the cap and logs it", () => {
    const log = vi.fn();
    const sent: number[] = [];
    let up = false;
    const o = new Outbox<number>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
      max: 100,
      log,
    });
    for (let i = 0; i < 105; i++) o.push(i);
    expect(o.size).toBe(100);
    expect(log).toHaveBeenCalledTimes(5);
    up = true;
    o.flush();
    expect(sent[0]).toBe(5);
    expect(sent).toHaveLength(100);
  });

  it("drops frames older than ten minutes and logs it", () => {
    let now = 0;
    let up = false;
    const log = vi.fn();
    const sent: string[] = [];
    const o = new Outbox<string>({
      send: (f) => {
        if (up) sent.push(f);
        return up;
      },
      now: () => now,
      log,
    });
    o.push("old");
    now = 9 * 60_000;
    o.push("new");
    now = 10 * 60_000 + 1;
    up = true;
    o.flush();
    expect(sent).toEqual(["new"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/expired/));
  });
});
