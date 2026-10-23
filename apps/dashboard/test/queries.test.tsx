import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import {
  type MachinesData,
  useMachines,
  useRevokeMachine,
} from "../src/api/queries";
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
          setTimeout(() => r(new HttpResponse(null, { status: 204 })), 300),
        ),
    ),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void revoke.result.current.mutateAsync("machine111111111");
  });
  await waitFor(() => expect(revoke.result.current.isPending).toBe(true));
  await waitFor(() =>
    expect(rowOf(list.result, "machine111111111")?.revokedAt).not.toBeNull(),
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

const A = "machineAAAAAAAAA";
const B = "machineBBBBBBBBB";
const two = [
  { ...machines[0], id: A, label: "a" },
  { ...machines[0], id: B, label: "b" },
];
const hold = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
};
const del = (id: string, status: number) =>
  http.delete(`*/api/v1/machines/${id}`, () =>
    status === 204
      ? new HttpResponse(null, { status })
      : HttpResponse.json(
          { error: { code: "internal", message: "Boom" } },
          { status },
        ),
  );
const rowOf = (r: { current: { data?: MachinesData } }, id: string) =>
  r.current.data?.machines.find((m) => m.id === id);

test("C1: overlapping failed clicks then a GET outage leave the row active", async () => {
  let down = false;
  const g = hold();
  server.use(
    http.get("*/api/v1/machines", () =>
      down
        ? HttpResponse.json(
            { error: { code: "internal", message: "x" } },
            { status: 500 },
          )
        : HttpResponse.json({ machines: two }),
    ),
    http.delete(`*/api/v1/machines/${A}`, async () => {
      await g.gate;
      return HttpResponse.json(
        { error: { code: "internal", message: "Boom" } },
        { status: 500 },
      );
    }),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  const settled: Promise<unknown>[] = [];
  await act(async () => {
    settled.push(revoke.result.current.mutateAsync(A).catch(() => {}));
    settled.push(revoke.result.current.mutateAsync(A).catch(() => {}));
  });
  await waitFor(() => expect(revoke.result.current.isPending).toBe(true));
  down = true;
  g.release();
  await act(async () => {
    await Promise.all(settled);
  });
  await waitFor(() => expect(revoke.result.current.isPending).toBe(false));
  expect(rowOf(list.result, A)?.revokedAt).toBeNull();
});

test("a 204 followed by a GET outage still shows the row revoked", async () => {
  let down = false;
  server.use(
    http.get("*/api/v1/machines", () =>
      down
        ? HttpResponse.json(
            { error: { code: "internal", message: "x" } },
            { status: 500 },
          )
        : HttpResponse.json({ machines: two }),
    ),
    http.delete(`*/api/v1/machines/${A}`, () => {
      down = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    await revoke.result.current.mutateAsync(A);
  });
  await waitFor(() => expect(revoke.result.current.isPending).toBe(false));
  expect(rowOf(list.result, A)?.revokedAt).not.toBeNull();
  expect(rowOf(list.result, B)?.revokedAt).toBeNull();
});

test("after a 204, the row never reads active between settle and refetch", async () => {
  let revoked = false;
  server.use(
    http.get("*/api/v1/machines", async () => {
      if (revoked) await new Promise((r) => setTimeout(r, 100));
      return HttpResponse.json({
        machines: two.map((m) =>
          revoked && m.id === A
            ? { ...m, revokedAt: "2026-10-22T00:00:00Z" }
            : m,
        ),
      });
    }),
    http.delete(`*/api/v1/machines/${A}`, () => {
      revoked = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { wrapper } = wrap();
  const seen: (string | null | undefined)[] = [];
  const list = renderHook(
    () => {
      const q = useMachines();
      seen.push(rowOf({ current: q }, A)?.revokedAt);
      return q;
    },
    { wrapper },
  );
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  const start = seen.length;
  await act(async () => {
    await revoke.result.current.mutateAsync(A);
  });
  await waitFor(() => expect(list.result.current.isFetching).toBe(false));
  expect(seen.slice(start)).not.toContain(null);
});

test("I2: A fails while B succeeds; B stays revoked", async () => {
  const gB = hold();
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines: two })),
    del(A, 500),
    http.delete(`*/api/v1/machines/${B}`, async () => {
      await gB.gate;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const ra = renderHook(() => useRevokeMachine(), { wrapper });
  const rb = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void rb.result.current.mutateAsync(B);
  });
  await act(async () => {
    await ra.result.current.mutateAsync(A).catch(() => {});
  });
  expect(rowOf(list.result, A)?.revokedAt).toBeNull();
  expect(rowOf(list.result, B)?.revokedAt).not.toBeNull();
  gB.release();
  await waitFor(() => expect(rb.result.current.isSuccess).toBe(true));
});

test("I3: invalidate during a pending DELETE keeps the row revoked", async () => {
  const g = hold();
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines: two })),
    http.delete(`*/api/v1/machines/${A}`, async () => {
      await g.gate;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { client, wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void revoke.result.current.mutateAsync(A);
  });
  // The overlay reaches the list hook asynchronously; wait for it before racing a refetch.
  await waitFor(() => expect(rowOf(list.result, A)?.revokedAt).not.toBeNull());
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["machines"] });
  });
  expect(rowOf(list.result, A)?.revokedAt).not.toBeNull();
  g.release();
  await waitFor(() => expect(revoke.result.current.isSuccess).toBe(true));
});

test("I4: a non-not_found 404 rejects", async () => {
  const { wrapper } = wrap();
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  server.use(
    http.delete(`*/api/v1/machines/${A}`, () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Boom" } },
        { status: 404 },
      ),
    ),
  );
  await act(async () => {
    await expect(revoke.result.current.mutateAsync(A)).rejects.toMatchObject({
      code: "internal",
    });
  });
});

test("M6: a revoke during the initial load does not cancel the GET", async () => {
  const gDel = hold();
  let aborted = false;
  server.use(
    http.get("*/api/v1/machines", async ({ request }) => {
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((r) => setTimeout(r, 80));
      return HttpResponse.json({ machines: two });
    }),
    http.delete(`*/api/v1/machines/${A}`, async () => {
      await gDel.gate;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void revoke.result.current.mutateAsync(A);
  });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  expect(aborted).toBe(false);
  expect(rowOf(list.result, A)?.revokedAt).not.toBeNull();
  gDel.release();
});

test("M7: the row shows revoked synchronously while DELETE is held", async () => {
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines: two })),
    http.delete(
      `*/api/v1/machines/${A}`,
      () => new Promise<Response>(() => {}),
    ),
  );
  const { wrapper } = wrap();
  const list = renderHook(() => useMachines(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toBeDefined());
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void revoke.result.current.mutateAsync(A);
  });
  await waitFor(() => expect(revoke.result.current.isPending).toBe(true));
  expect(rowOf(list.result, A)?.revokedAt).not.toBeNull();
  expect(rowOf(list.result, B)?.revokedAt).toBeNull();
});

test("a second revoke of a pending id sends no second DELETE", async () => {
  const g = hold();
  let n = 0;
  server.use(
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines: two })),
    http.delete(`*/api/v1/machines/${A}`, async () => {
      n++;
      await g.gate;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { wrapper } = wrap();
  const revoke = renderHook(() => useRevokeMachine(), { wrapper });
  await act(async () => {
    void revoke.result.current.mutateAsync(A);
    void revoke.result.current.mutateAsync(A);
  });
  await waitFor(() => expect(n).toBe(1));
  g.release();
  await waitFor(() => expect(revoke.result.current.isPending).toBe(false));
  expect(n).toBe(1);
});
