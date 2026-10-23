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

let restore: (() => void) | undefined;
beforeEach(() => {
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

test("live follows hello and a drop; hello refetches both lists", () => {
  const { result, invalidate } = setup();
  expect(result.current.live).toBe(false);
  act(() => lastSource().push({ type: "hello" }));
  expect(result.current.live).toBe(true);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.machines });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.agents });
  act(() => lastSource().fail());
  expect(result.current.live).toBe(false);
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  expect(result.current.live).toBe(false); // reconnecting is not live until hello
  act(() => lastSource().push({ type: "hello" }));
  expect(result.current.live).toBe(true);
});

test("a snapshot is written into its own cache only", () => {
  const { client } = setup();
  act(() => lastSource().push({ type: "machines", machines: [machine] }));
  expect(client.getQueryData(qk.machines)).toEqual({ machines: [machine] });
  expect(client.getQueryData(qk.agents)).toBeUndefined();
});

test("an unknown or unreadable frame refetches both lists", () => {
  const { invalidate } = setup();
  act(() => lastSource().push({ type: "roster_changed" }));
  expect(invalidate).toHaveBeenCalledTimes(2);
  act(() => lastSource().pushRaw("junk"));
  expect(invalidate).toHaveBeenCalledTimes(4);
});

test("unmount closes the stream; later frames, errors and timers do nothing", () => {
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
  expect(result.current.live).toBe(false);
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
