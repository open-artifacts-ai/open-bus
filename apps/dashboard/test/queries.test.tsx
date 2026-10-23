import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { useMachines, useRevokeMachine } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
import { installHarness, server } from "./harness";

installHarness();

const machines = [
  {
    id: "machine111111111",
    label: "studio-mbp",
    createdAt: "2026-10-21T10:00:00Z",
    lastUsed: null,
    revokedAt: null,
  },
];

const wrap = (client = makeQueryClient()) => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
};

test("useMachines loads the list", async () => {
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines })),
  );
  const { wrapper } = wrap();
  const { result } = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(result.current.data?.machines).toHaveLength(1));
  expect(result.current.data?.machines?.[0]?.label).toBe("studio-mbp");
});

test("revoke marks the row revoked before the server answers", async () => {
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines })),
    http.delete(
      "*/api/v1/machines/machine111111111",
      () =>
        new Promise((r) =>
          setTimeout(() => r(new HttpResponse(null, { status: 204 })), 50),
        ),
    ),
  );
  const { client, wrapper } = wrap();
  const { result: list } = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });

  await act(async () => {
    void revoke.result.current.mutateAsync("machine111111111");
  });
  await waitFor(() =>
    expect(
      client.getQueryData<{ machines: typeof machines }>(["machines"])
        ?.machines[0]?.revokedAt,
    ).not.toBeNull(),
  );
  await waitFor(() => expect(revoke.result.current.isSuccess).toBe(true));
});

test("a failed revoke rolls the row back", async () => {
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines })),
    http.delete("*/api/v1/machines/machine111111111", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Boom" } },
        { status: 500 },
      ),
    ),
  );
  const { client, wrapper } = wrap();
  const { result: list } = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });

  await act(async () => {
    await revoke.result.current.mutateAsync("machine111111111").catch(() => {});
  });
  const row = client.getQueryData<{ machines: typeof machines }>(["machines"])
    ?.machines[0];
  expect(row?.revokedAt).toBeNull();
});

test("a 404 on revoke is success: the machine was already revoked", async () => {
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines })),
    http.delete("*/api/v1/machines/machine111111111", () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "No such machine" } },
        { status: 404 },
      ),
    ),
  );
  const { wrapper } = wrap();
  const { result: list } = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });

  await act(async () => {
    await revoke.result.current.mutateAsync("machine111111111");
  });
  await waitFor(() => expect(revoke.result.current.isSuccess).toBe(true));
});
