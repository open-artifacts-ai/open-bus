import { afterEach, expect, test, vi } from "vitest";
import {
  type BusEventsOptions,
  connectBusEvents,
  patchFor,
} from "../src/live/busEvents";
import {
  FakeEventSource,
  installFakeEventSource,
  lastSource,
} from "./fakeEventSource";

let restore: (() => void) | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  restore?.();
  restore = undefined;
  vi.useRealTimers();
});

const opts = (over: Partial<BusEventsOptions> = {}): BusEventsOptions => ({
  onHello: vi.fn(),
  onSnapshot: vi.fn(),
  onDown: vi.fn(),
  onUnknown: vi.fn(),
  ...over,
});

/** Connect and let the deferred open (a 0 ms timer, so StrictMode can't connect) fire. */
const start = (o: BusEventsOptions = opts()) => {
  vi.useFakeTimers();
  restore = installFakeEventSource();
  const c = connectBusEvents(o);
  vi.advanceTimersByTime(0);
  return c;
};

const agent = {
  id: "agent11111111111",
  namespace: "repo:github.com/acme/app",
  name: "claude-1",
  kind: "claude-code" as const,
  machineId: "machine111111111",
  machineLabel: "studio-mbp",
  global: false,
  live: true,
  updatedAt: "2026-10-21T10:00:00Z",
};

test("patchFor maps snapshots and refuses frames it does not know", () => {
  expect(patchFor({ type: "agents", agents: [agent] })).toEqual({
    agents: [agent],
  });
  expect(patchFor({ type: "hello" })).toBeNull();
  expect(patchFor({ type: "agent_up" } as never)).toBeNull();
});

test("hello refetches, snapshots patch", () => {
  const o = opts();
  const c = start(o);
  const es = lastSource();
  expect(es.url).toBe("/api/v1/events");
  es.push({ type: "hello" });
  expect(o.onHello).toHaveBeenCalledOnce();
  es.push({ type: "agents", agents: [agent] });
  expect(o.onSnapshot).toHaveBeenCalledWith({ agents: [agent] });
  c.close();
});

test("an unknown frame type asks for a refetch instead of guessing", () => {
  const o = opts();
  start(o);
  lastSource().push({ type: "roster_changed" });
  expect(o.onUnknown).toHaveBeenCalledOnce();
});

test("garbage frames (bad JSON, bad shape, non-string) ask for a refetch", () => {
  const o = opts();
  start(o);
  const es = lastSource();
  es.pushRaw("{not json");
  es.pushRaw(undefined);
  es.push({ type: "agents", agents: [{ id: "x" }] });
  es.push({ type: "hello", extra: 1 });
  expect(o.onUnknown).toHaveBeenCalledTimes(4);
  expect(o.onSnapshot).not.toHaveBeenCalled();
  expect(o.onHello).not.toHaveBeenCalled();
});

test("a drop after hello reconnects with backoff", () => {
  const o = opts();
  start(o);
  lastSource().push({ type: "hello" });
  lastSource().fail();
  expect(o.onDown).toHaveBeenCalledOnce();
  expect(FakeEventSource.all).toHaveLength(1);
  expect(FakeEventSource.all[0]?.closed).toBe(true);
  vi.advanceTimersByTime(1_000);
  expect(FakeEventSource.all).toHaveLength(2);
});

test("backoff doubles to a 30 s cap and hello resets it", () => {
  start();
  lastSource().push({ type: "hello" });
  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const n = FakeEventSource.all.length;
    lastSource().fail();
    vi.advanceTimersByTime(wait - 1);
    expect(FakeEventSource.all).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.all).toHaveLength(n + 1);
  }
  lastSource().push({ type: "hello" });
  const n = FakeEventSource.all.length;
  lastSource().fail();
  vi.advanceTimersByTime(1_000);
  expect(FakeEventSource.all).toHaveLength(n + 1);
});

test("a bare open does not reset the backoff (a flapping server cannot storm)", () => {
  start();
  lastSource().push({ type: "hello" });
  lastSource().fail();
  vi.advanceTimersByTime(1_000);
  lastSource().onopen?.();
  lastSource().fail();
  vi.advanceTimersByTime(1_999);
  expect(FakeEventSource.all).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeEventSource.all).toHaveLength(3);
});

test("a failure before the first hello waits for retry(), not a storm", () => {
  const c = start();
  lastSource().fail();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(1);
  c.retry();
  expect(FakeEventSource.all).toHaveLength(2);
  c.close();
});

test("an error storm on one socket reports down and schedules once", () => {
  const o = opts();
  start(o);
  lastSource().push({ type: "hello" });
  const es = lastSource();
  for (let i = 0; i < 20; i++) es.fail();
  expect(o.onDown).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1_000);
  expect(FakeEventSource.all).toHaveLength(2);
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(2);
});

test("retry() never opens a second source while one is live or a timer is pending", () => {
  const c = start();
  c.retry();
  expect(FakeEventSource.all).toHaveLength(1);
  lastSource().push({ type: "hello" });
  c.retry();
  expect(FakeEventSource.all).toHaveLength(1);
  lastSource().fail();
  c.retry(); // reconnect timer pending
  expect(FakeEventSource.all).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(FakeEventSource.all).toHaveLength(2);
  c.retry();
  expect(FakeEventSource.all).toHaveLength(2);
  c.close();
});

test("retry() twice after a failed first connect opens one source", () => {
  const c = start();
  lastSource().fail();
  c.retry();
  c.retry();
  expect(FakeEventSource.all).toHaveLength(2);
  c.close();
});

test("close stops reconnecting", () => {
  const c = start();
  lastSource().push({ type: "hello" });
  c.close();
  expect(lastSource().closed).toBe(true);
  lastSource().fail();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(1);
});

test("close during a pending reconnect timer cancels it", () => {
  const c = start();
  lastSource().push({ type: "hello" });
  lastSource().fail();
  c.close();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(1);
});

test("close before the deferred open means no source is ever created", () => {
  vi.useFakeTimers();
  restore = installFakeEventSource();
  connectBusEvents(opts()).close();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(0);
});

test("retry() after close is a no-op", () => {
  const c = start();
  lastSource().fail();
  c.close();
  c.retry();
  expect(FakeEventSource.all).toHaveLength(1);
});

test("frames after close or from a replaced socket are ignored", () => {
  const o = opts();
  const c = start(o);
  const first = lastSource();
  first.push({ type: "hello" });
  first.fail();
  vi.advanceTimersByTime(1_000);
  vi.mocked(o.onHello).mockClear();
  first.push({ type: "hello" });
  first.pushRaw("junk");
  first.fail();
  expect(o.onHello).not.toHaveBeenCalled();
  expect(o.onUnknown).not.toHaveBeenCalled();
  expect(o.onDown).toHaveBeenCalledOnce();
  const second = lastSource();
  c.close();
  second.push({ type: "agents", agents: [agent] });
  second.pushRaw("junk");
  second.fail();
  expect(o.onSnapshot).not.toHaveBeenCalled();
  expect(o.onUnknown).not.toHaveBeenCalled();
  expect(o.onDown).toHaveBeenCalledOnce();
});

/** The node project has no `document`; the runner only reads `.hidden`. */
const setHidden = (hidden: boolean) => vi.stubGlobal("document", { hidden });

test("a drop while the tab is hidden parks instead of scheduling; retry() reconnects", () => {
  const c = start();
  lastSource().push({ type: "hello" });
  setHidden(true);
  lastSource().fail();
  vi.advanceTimersByTime(120_000);
  expect(FakeEventSource.all).toHaveLength(1);
  setHidden(false);
  c.retry();
  expect(FakeEventSource.all).toHaveLength(2);
  c.close();
});

test("a reconnect timer that fires while hidden parks", () => {
  const c = start();
  lastSource().push({ type: "hello" });
  lastSource().fail();
  setHidden(true);
  vi.advanceTimersByTime(1_000);
  expect(FakeEventSource.all).toHaveLength(1);
  setHidden(false);
  c.retry();
  expect(FakeEventSource.all).toHaveLength(2);
  c.close();
});
