import { afterEach, expect, test, vi } from "vitest";
import {
  type BusEventsOptions,
  connectBusEvents,
  eventsUrl,
  PING_MS,
  patchFor,
} from "../src/live/busEvents";
import {
  FakeWebSocket,
  installFakeWebSocket,
  lastSocket,
} from "./fakeWebSocket";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const opts = (over: Partial<BusEventsOptions> = {}): BusEventsOptions => ({
  onHello: vi.fn(),
  onSnapshot: vi.fn(),
  onDown: vi.fn(),
  onUnknown: vi.fn(),
  onSignedOut: vi.fn(),
  ...over,
});

/** Connect and let the deferred open (a 0 ms timer, so StrictMode can't connect) fire. */
const start = (o: BusEventsOptions = opts()) => {
  vi.useFakeTimers();
  installFakeWebSocket();
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:5173" });
  const c = connectBusEvents(o);
  vi.advanceTimersByTime(0);
  return c;
};

const agent = {
  id: "agent11111111111",
  namespace: "github.com/acme/app",
  name: "claude-1",
  kind: "claude-code" as const,
  machineId: "machine111111111",
  machineLabel: "studio-mbp",
  global: false,
  state: "live" as const,
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
  const es = lastSocket();
  expect(es.url).toBe("ws://localhost:5173/api/v1/events");
  es.push({ type: "hello" });
  expect(o.onHello).toHaveBeenCalledOnce();
  es.push({ type: "agents", agents: [agent] });
  expect(o.onSnapshot).toHaveBeenCalledWith({ agents: [agent] });
  c.close();
});

test("an unknown frame type asks for a refetch instead of guessing", () => {
  const o = opts();
  start(o);
  lastSocket().push({ type: "roster_changed" });
  expect(o.onUnknown).toHaveBeenCalledOnce();
});

test("garbage frames (bad JSON, bad shape, non-string) ask for a refetch", () => {
  const o = opts();
  start(o);
  const es = lastSocket();
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
  lastSocket().push({ type: "hello" });
  lastSocket().fail();
  expect(o.onDown).toHaveBeenCalledOnce();
  expect(FakeWebSocket.all).toHaveLength(1);
  expect(FakeWebSocket.all[0]?.closed).toBe(true);
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(2);
});

test("backoff doubles to a 30 s cap and hello resets it", () => {
  start();
  lastSocket().push({ type: "hello" });
  for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const n = FakeWebSocket.all.length;
    lastSocket().fail();
    vi.advanceTimersByTime(wait - 1);
    expect(FakeWebSocket.all).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.all).toHaveLength(n + 1);
  }
  lastSocket().push({ type: "hello" });
  const n = FakeWebSocket.all.length;
  lastSocket().fail();
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(n + 1);
});

test("a bare open does not reset the backoff (a flapping server cannot storm)", () => {
  start();
  lastSocket().push({ type: "hello" });
  lastSocket().fail();
  vi.advanceTimersByTime(1_000);
  lastSocket().open();
  lastSocket().fail();
  vi.advanceTimersByTime(1_999);
  expect(FakeWebSocket.all).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.all).toHaveLength(3);
});

test("a failure before the first hello waits for retry(), not a storm", () => {
  const c = start();
  lastSocket().fail();
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.all).toHaveLength(1);
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(2);
  c.close();
});

test("an error storm on one socket reports down and schedules once", () => {
  const o = opts();
  start(o);
  lastSocket().push({ type: "hello" });
  const es = lastSocket();
  for (let i = 0; i < 20; i++) es.fail();
  expect(o.onDown).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(2);
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.all).toHaveLength(2);
});

test("retry() never opens a second source while one is live or a timer is pending", () => {
  const c = start();
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(1);
  lastSocket().push({ type: "hello" });
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(1);
  lastSocket().fail();
  c.retry(); // reconnect timer pending
  expect(FakeWebSocket.all).toHaveLength(1);
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(2);
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(2);
  c.close();
});

test("retry() twice after a failed first connect opens one source", () => {
  const c = start();
  lastSocket().fail();
  c.retry();
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(2);
  c.close();
});

test("close stops reconnecting", () => {
  const c = start();
  lastSocket().push({ type: "hello" });
  c.close();
  expect(lastSocket().closed).toBe(true);
  lastSocket().fail();
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.all).toHaveLength(1);
});

test("close during a pending reconnect timer cancels it", () => {
  const c = start();
  lastSocket().push({ type: "hello" });
  lastSocket().fail();
  c.close();
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.all).toHaveLength(1);
});

test("close before the deferred open means no source is ever created", () => {
  vi.useFakeTimers();
  installFakeWebSocket();
  connectBusEvents(opts()).close();
  vi.advanceTimersByTime(60_000);
  expect(FakeWebSocket.all).toHaveLength(0);
});

test("retry() after close is a no-op", () => {
  const c = start();
  lastSocket().fail();
  c.close();
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(1);
});

test("frames after close or from a replaced socket are ignored", () => {
  const o = opts();
  const c = start(o);
  const first = lastSocket();
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
  const second = lastSocket();
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
  lastSocket().push({ type: "hello" });
  setHidden(true);
  lastSocket().fail();
  vi.advanceTimersByTime(120_000);
  expect(FakeWebSocket.all).toHaveLength(1);
  setHidden(false);
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(2);
  c.close();
});

test("a reconnect timer that fires while hidden parks", () => {
  const c = start();
  lastSocket().push({ type: "hello" });
  lastSocket().fail();
  setHidden(true);
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(1);
  setHidden(false);
  c.retry();
  expect(FakeWebSocket.all).toHaveLength(2);
  c.close();
});

test("the URL follows the page: wss on https, ws on http, same host", () => {
  expect(eventsUrl({ protocol: "https:", host: "bus.example.com" })).toBe(
    "wss://bus.example.com/api/v1/events",
  );
  expect(eventsUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
    "ws://localhost:5173/api/v1/events",
  );
});

test.each([
  [1013, "evicted (16-socket cap)"],
  [1011, "send failure"],
  [1000, "a clean close"],
  [1006, "an abnormal close"],
])("close %i (%s) after hello reconnects with backoff", (code) => {
  const o = opts();
  start(o);
  lastSocket().push({ type: "hello" });
  lastSocket().serverClose(code);
  expect(o.onDown).toHaveBeenCalledOnce();
  expect(o.onSignedOut).not.toHaveBeenCalled();
  vi.advanceTimersByTime(999);
  expect(FakeWebSocket.all).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.all).toHaveLength(2);
  lastSocket().serverClose(code);
  vi.advanceTimersByTime(1_999);
  expect(FakeWebSocket.all).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(FakeWebSocket.all).toHaveLength(3);
});

test("4401 (session ended) signs out and never reconnects", () => {
  const o = opts();
  const c = start(o);
  lastSocket().push({ type: "hello" });
  lastSocket().serverClose(4401);
  expect(o.onSignedOut).toHaveBeenCalledOnce();
  expect(o.onDown).not.toHaveBeenCalled();
  vi.advanceTimersByTime(120_000);
  expect(c.retry()).toBe(false);
  expect(FakeWebSocket.all).toHaveLength(1);
});

test("4401 before hello signs out too", () => {
  const o = opts();
  const c = start(o);
  lastSocket().serverClose(4401);
  expect(o.onSignedOut).toHaveBeenCalledOnce();
  expect(c.retry()).toBe(false);
  expect(FakeWebSocket.all).toHaveLength(1);
});

test('"pong" is not a frame: no refetch, no snapshot', () => {
  const o = opts();
  start(o);
  lastSocket().push({ type: "hello" });
  lastSocket().pushRaw("pong");
  expect(o.onUnknown).not.toHaveBeenCalled();
  expect(o.onSnapshot).not.toHaveBeenCalled();
});

test('the client only ever sends "ping", every 30 s while visible and open', () => {
  const c = start();
  const s = lastSocket();
  vi.advanceTimersByTime(PING_MS);
  expect(s.sent).toEqual([]); // still connecting
  s.open();
  s.push({ type: "hello" });
  vi.advanceTimersByTime(PING_MS);
  expect(s.sent).toEqual(["ping"]);
  setHidden(true);
  vi.advanceTimersByTime(PING_MS * 3);
  expect(s.sent).toEqual(["ping"]);
  setHidden(false);
  vi.advanceTimersByTime(PING_MS);
  expect(s.sent).toEqual(["ping", "ping"]);
  c.close();
  vi.advanceTimersByTime(PING_MS * 3);
  expect(s.sent).toEqual(["ping", "ping"]);
  expect(FakeWebSocket.all).toHaveLength(1);
});

test("a ping with no pong by the next one drops the socket and reconnects", () => {
  const o = opts();
  start(o);
  const s = lastSocket();
  s.open();
  s.push({ type: "hello" });
  s.autoPong = false;
  vi.advanceTimersByTime(PING_MS);
  expect(o.onDown).not.toHaveBeenCalled();
  vi.advanceTimersByTime(PING_MS);
  expect(s.closedWith).toBe(1000);
  expect(o.onDown).toHaveBeenCalledOnce();
  s.serverClose(1006); // the close event that follows changes nothing
  expect(o.onDown).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1_000);
  expect(FakeWebSocket.all).toHaveLength(2);
});

test("close() closes the socket with 1000", () => {
  const c = start();
  const s = lastSocket();
  s.open();
  c.close();
  expect(s.closedWith).toBe(1000);
});
