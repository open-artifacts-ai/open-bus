import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useMachines } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
import { useBusEvents } from "../src/live/useBusEvents";
import {
  FakeEventSource,
  installFakeEventSource,
  lastSource,
} from "./fakeEventSource";
import { installHarness, server } from "./harness";

installHarness();

let restore: (() => void) | undefined;
beforeEach(() => {
  restore = installFakeEventSource();
});
afterEach(() => restore?.());

const mk = (id: string, label: string) => ({
  id,
  label,
  createdAt: "2026-10-21T10:00:00Z",
  lastUsed: null,
  revokedAt: null,
  connected: false,
});

test("an older in-flight GET cannot overwrite a newer snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let hits = 0;
  server.use(
    http.get("*/api/v1/machines", async () => {
      hits++;
      await gate;
      return HttpResponse.json({ machines: [mk("machine111111111", "stale")] });
    }),
  );
  const client = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => {
      useBusEvents();
      return useMachines();
    },
    { wrapper },
  );
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  await waitFor(() => expect(hits).toBe(1));
  expect(result.current.data).toBeUndefined();

  await act(async () => {
    lastSource().push({
      type: "machines",
      machines: [mk("machine111111111", "fresh")],
    });
  });
  // Cancelling the initial GET must not leave the query pending without data.
  await waitFor(() =>
    expect(result.current.data?.machines[0]?.label).toBe("fresh"),
  );
  expect(result.current.isPending).toBe(false);

  release();
  await new Promise((r) => setTimeout(r, 50));
  expect(result.current.data?.machines[0]?.label).toBe("fresh");
});
