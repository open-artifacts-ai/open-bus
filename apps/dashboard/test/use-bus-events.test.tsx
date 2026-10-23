import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { qk } from "../src/api/qk";
import { makeQueryClient } from "../src/api/queryClient";
import { useBusEvents } from "../src/live/useBusEvents";
import {
  FakeEventSource,
  installFakeEventSource,
  lastSource,
} from "./fakeEventSource";

const setHidden = (hidden: boolean) =>
  Object.defineProperty(document, "hidden", {
    value: hidden,
    configurable: true,
  });

let restore: (() => void) | undefined;
beforeEach(() => {
  setHidden(false);
  vi.useFakeTimers();
  restore = installFakeEventSource();
});
afterEach(() => {
  restore?.();
  vi.useRealTimers();
});

const machine = {
  id: "machine111111111",
  label: "studio-mbp",
  createdAt: "2026-10-21T10:00:00Z",
  lastUsed: null,
  revokedAt: null,
  connected: false,
};

const setup = (strict = false) => {
  const client = makeQueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return strict ? <StrictMode>{inner}</StrictMode> : inner;
  };
  const view = renderHook(() => useBusEvents(), { wrapper });
  act(() => {
    vi.advanceTimersByTime(0);
  });
  return { client, invalidate, ...view };
};

test("status goes connecting -> live -> paused -> (reconnect) paused -> live", () => {
  const { result } = setup();
  expect(result.current.status).toBe("connecting");
  act(() => lastSource().push({ type: "hello" }));
  expect(result.current.status).toBe("live");
  act(() => lastSource().fail());
  expect(result.current.status).toBe("paused");
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(result.current.status).toBe("paused"); // not live until hello
  act(() => lastSource().push({ type: "hello" }));
  expect(result.current.status).toBe("live");
});

test("a snapshot is written into its own cache only", async () => {
  const { client } = setup();
  await act(async () =>
    lastSource().push({ type: "machines", machines: [machine] }),
  );
  expect(client.getQueryData(qk.machines)).toEqual({ machines: [machine] });
  expect(client.getQueryData(qk.agents)).toBeUndefined();
});

test("an unknown or unreadable frame refetches both lists, once per second", () => {
  const { invalidate } = setup();
  act(() => lastSource().push({ type: "roster_changed" }));
  expect(invalidate).not.toHaveBeenCalled(); // trailing edge
  act(() => lastSource().pushRaw("junk"));
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(invalidate).toHaveBeenCalledTimes(2);
  act(() => lastSource().push({ type: "roster_changed" }));
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(invalidate).toHaveBeenCalledTimes(4);
});

test("50 unknown frames coalesce into exactly two invalidations", () => {
  const { invalidate } = setup();
  act(() => {
    for (let i = 0; i < 50; i++) lastSource().push({ type: `new_${i}` });
  });
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(invalidate).toHaveBeenCalledTimes(2);
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(invalidate).toHaveBeenCalledTimes(2);
});

test("unmount clears a pending trailing refetch", () => {
  const { invalidate, unmount } = setup();
  act(() => lastSource().push({ type: "roster_changed" }));
  unmount();
  vi.advanceTimersByTime(5_000);
  expect(invalidate).not.toHaveBeenCalled();
});

const listGets = (invalidate: ReturnType<typeof vi.fn>) =>
  invalidate.mock.calls
    .map(([f]) => (f as { queryKey: readonly string[] }).queryKey[0])
    .filter((k) => k !== qk.me[0]);

test("hello followed by both greeting snapshots refetches nothing", async () => {
  const { invalidate } = setup();
  await act(async () => {
    lastSource().push({ type: "hello" });
    lastSource().push({ type: "machines", machines: [machine] });
    lastSource().push({ type: "agents", agents: [] });
  });
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(listGets(invalidate)).toEqual([]);
});

test("hello refetches only the lists whose snapshot didn't follow within the window", async () => {
  const { invalidate } = setup();
  await act(async () => {
    lastSource().push({ type: "hello" });
    lastSource().push({ type: "machines", machines: [machine] });
  });
  act(() => {
    vi.advanceTimersByTime(999);
  });
  expect(listGets(invalidate)).toEqual([]);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(listGets(invalidate)).toEqual(["agents"]);
});

test("hello with no snapshot refetches both lists once, absorbing a pending trailing refetch", () => {
  const { invalidate } = setup();
  act(() => lastSource().push({ type: "roster_changed" }));
  act(() => lastSource().push({ type: "hello" }));
  expect(listGets(invalidate)).toEqual([]);
  act(() => {
    vi.advanceTimersByTime(5_000);
  });
  expect(listGets(invalidate).sort()).toEqual(["agents", "machines"]);
});

test("an unknown frame after hello still refetches (Decision 2)", async () => {
  const { invalidate } = setup();
  await act(async () => {
    lastSource().push({ type: "hello" });
    lastSource().push({ type: "machines", machines: [machine] });
    lastSource().push({ type: "agents", agents: [] });
  });
  act(() => lastSource().push({ type: "roster_changed" }));
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(listGets(invalidate).sort()).toEqual(["agents", "machines"]);
});

test("unmount clears a pending hello refetch", () => {
  const { invalidate, unmount } = setup();
  act(() => lastSource().push({ type: "hello" }));
  unmount();
  vi.advanceTimersByTime(5_000);
  expect(listGets(invalidate)).toEqual([]);
});

test("a hidden tab does not reconnect until it is visible again", () => {
  const { result } = setup();
  act(() => lastSource().push({ type: "hello" }));
  setHidden(true);
  act(() => lastSource().fail());
  act(() => {
    vi.advanceTimersByTime(120_000);
  });
  expect(FakeEventSource.all).toHaveLength(1);
  expect(result.current.status).toBe("paused");
  setHidden(false);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(FakeEventSource.all).toHaveLength(2);
  act(() => lastSource().push({ type: "hello" }));
  expect(result.current.status).toBe("live");
});

test("unmount closes the stream; later frames, errors and timers do nothing", async () => {
  const { client, invalidate, unmount } = setup();
  act(() => lastSource().push({ type: "hello" }));
  const es = lastSource();
  invalidate.mockClear();
  unmount();
  expect(es.closed).toBe(true);
  es.push({ type: "machines", machines: [machine] });
  es.pushRaw("junk");
  es.fail();
  vi.advanceTimersByTime(60_000);
  await Promise.resolve();
  expect(client.getQueryData(qk.machines)).toBeUndefined();
  expect(invalidate).not.toHaveBeenCalled();
  expect(FakeEventSource.all).toHaveLength(1);
});

test("unmount during a reconnect timer opens nothing", () => {
  const { unmount } = setup();
  act(() => lastSource().push({ type: "hello" }));
  act(() => lastSource().fail());
  unmount();
  vi.advanceTimersByTime(60_000);
  expect(FakeEventSource.all).toHaveLength(1);
});

test("StrictMode double-mount leaves exactly one open EventSource", () => {
  setup(true);
  const open = FakeEventSource.all.filter((s) => !s.closed);
  expect(open).toHaveLength(1);
  expect(FakeEventSource.all).toHaveLength(1);
});

test("focus after a failed first connect retries once; focus while live does not", () => {
  const { result } = setup();
  act(() => lastSource().fail());
  expect(result.current.status).toBe("paused");
  act(() => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(FakeEventSource.all).toHaveLength(2);
  act(() => lastSource().push({ type: "hello" }));
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(FakeEventSource.all).toHaveLength(2);
});

test("focus listeners are removed on unmount", () => {
  const { unmount } = setup();
  act(() => lastSource().fail());
  unmount();
  window.dispatchEvent(new Event("focus"));
  expect(FakeEventSource.all).toHaveLength(1);
});

test("every drop re-checks the session (EventSource can't see a 401)", () => {
  const { invalidate } = setup();
  act(() => lastSource().fail());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.me });
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  act(() => lastSource().push({ type: "hello" }));
  invalidate.mockClear();
  act(() => lastSource().fail());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.me });
});
