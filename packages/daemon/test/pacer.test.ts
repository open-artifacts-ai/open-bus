import type { ClientFrame } from "@ob/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FramePacer } from "../src/pacer.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const f = (type: string, n = 0) =>
  ({ v: 1, id: `${type}-${n}`, type }) as unknown as ClientFrame;

function pacer(
  over: Partial<ConstructorParameters<typeof FramePacer>[0]> = {},
) {
  const sent: { id: string; at: number }[] = [];
  const p = new FramePacer({
    send: (data) => {
      sent.push({ id: data, at: Date.now() });
    },
    ...over,
  });
  return { p, sent, ids: () => sent.map((s) => s.id) };
}

describe("frame pacer", () => {
  it("never sends more than 40 frames in any second under a burst of 300", () => {
    const { p, sent } = pacer();
    for (let i = 0; i < 300; i++) p.push(f("send", i), `s${i}`);
    vi.advanceTimersByTime(20_000);
    expect(sent).toHaveLength(300);
    for (let i = 0; i < sent.length; i++) {
      const inWindow = sent.filter(
        (s) => s.at >= sent[i].at && s.at < sent[i].at + 1000,
      ).length;
      expect(inWindow).toBeLessThanOrEqual(40);
    }
    // Paced, not dribbled: 300 frames go out in well under 10 s.
    expect(sent.at(-1)?.at ?? 0).toBeLessThan(sent[0].at + 10_000);
  });

  it("sends a small burst at once and the rest paced", () => {
    const { p, sent } = pacer();
    for (let i = 0; i < 20; i++) p.push(f("send", i), `s${i}`);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(20);
  });

  it("sends hello, then ack/refuse, then agent_up/agent_down/sessions, then the rest", () => {
    const { p, ids } = pacer({ burst: 1 });
    // The first push takes the only token; everything after it queues.
    p.push(f("list", 0), "list0");
    p.push(f("send", 1), "send1");
    p.push(f("agent_up", 2), "up2");
    p.push(f("fetch", 3), "fetch3");
    p.push(f("sessions", 4), "sessions4");
    p.push(f("ack", 5), "ack5");
    p.push(f("agent_down", 6), "down6");
    p.push(f("refuse", 7), "refuse7");
    p.push(f("hello", 8), "hello8");
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual([
      "list0",
      "hello8",
      "ack5",
      "refuse7",
      "up2",
      "sessions4",
      "down6",
      "send1",
      "fetch3",
    ]);
  });

  it("drops the oldest lowest-priority frame when full, logs it and reports it", () => {
    const log = vi.fn();
    const onDropped = vi.fn();
    const { p, ids } = pacer({ burst: 1, max: 3, log, onDropped });
    p.push(f("hello"), "hello"); // sent at once
    expect(p.push(f("send", 1), "send1")).toBe(true);
    expect(p.push(f("agent_up", 2), "up2")).toBe(true);
    expect(p.push(f("send", 3), "send3")).toBe(true);
    expect(p.push(f("ack", 4), "ack4")).toBe(true);
    expect(onDropped).toHaveBeenCalledWith(f("send", 1));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/dropped .*send/));
    expect(p.size).toBe(3);
    vi.advanceTimersByTime(5_000);
    expect(ids()).toEqual(["hello", "ack4", "up2", "send3"]);
  });

  it("refuses a new frame when the queue is full of higher-priority ones", () => {
    const onDropped = vi.fn();
    const { p } = pacer({ burst: 1, max: 2, onDropped });
    p.push(f("hello"), "hello");
    p.push(f("ack", 1), "ack1");
    p.push(f("ack", 2), "ack2");
    expect(p.push(f("send", 3), "send3")).toBe(false);
    expect(onDropped).not.toHaveBeenCalled();
    expect(p.size).toBe(2);
  });

  it("clear() drops what is queued and stops the timer", () => {
    const { p, sent } = pacer({ burst: 1 });
    for (let i = 0; i < 10; i++) p.push(f("send", i), `s${i}`);
    p.clear();
    expect(p.size).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a send that throws is logged and pacing continues", () => {
    const log = vi.fn();
    let n = 0;
    const p = new FramePacer({
      burst: 1,
      log,
      send: () => {
        if (n++ === 1) throw new Error("boom");
      },
    });
    for (let i = 0; i < 4; i++) p.push(f("send", i), `s${i}`);
    vi.advanceTimersByTime(5_000);
    expect(n).toBe(4);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/boom/));
  });
});
