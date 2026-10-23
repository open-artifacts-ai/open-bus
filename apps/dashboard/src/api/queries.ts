import {
  type QueryClient,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { ApiClientError, api } from "./client";
import {
  type Agent,
  AgentsResponseSchema,
  type Machine,
  MachinesResponseSchema,
  MeSchema,
  R,
} from "./contract";
import { qk } from "./qk";

export type MachinesData = { machines: Machine[] };
export type AgentsData = { agents: Agent[] };

export const useMe = () =>
  useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => api.get(R.me, MeSchema, signal),
    staleTime: 60_000,
    retry: false,
  });

const REVOKE_KEY = [...qk.machines, "revoke"] as const;

/** One in-flight DELETE per (client, id), so a double click sends one request. */
const inflight = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/**
 * The cache only ever holds server data. Pending revokes are overlaid at read
 * time, so a refetch, an SSE snapshot or another row's failure can't clobber them.
 */
export const useMachines = () => {
  const query = useQuery({
    queryKey: qk.machines,
    queryFn: ({ signal }) =>
      api.get(R.machines, MachinesResponseSchema, signal),
    staleTime: 10_000,
  });
  const pending = useMutationState({
    filters: { mutationKey: REVOKE_KEY, status: "pending" },
    select: (m) => ({
      id: m.state.variables as string,
      at: new Date(m.state.submittedAt).toISOString(),
    }),
  });
  const key = pending.map((p) => `${p.id}@${p.at}`).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` encodes `pending`
  const data = useMemo<MachinesData | undefined>(() => {
    if (!query.data || pending.length === 0) return query.data;
    const at = new Map(pending.map((p) => [p.id, p.at]));
    return {
      machines: query.data.machines.map((m) =>
        at.has(m.id)
          ? { ...m, revokedAt: m.revokedAt ?? (at.get(m.id) as string) }
          : m,
      ),
    };
  }, [query.data, key]);
  return { ...query, data };
};

export const useAgents = () =>
  useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.get(R.agents, AgentsResponseSchema, signal),
    staleTime: 10_000,
  });

/**
 * DELETE /api/v1/machines/:id. The optimistic state lives in `useMachines`
 * (pending variables), not in the cache, so there is nothing to roll back.
 * A `not_found` means the machine was already revoked, the same end state.
 * Feedback (toasts) is the caller's job.
 */
export const useRevokeMachine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: REVOKE_KEY,
    mutationFn: (id: string) => {
      const live = inflight.get(qc) ?? new Map<string, Promise<void>>();
      inflight.set(qc, live);
      const running = live.get(id);
      if (running) return running;
      const p = api.send("DELETE", R.machine(id)).then(
        () => undefined,
        (e) => {
          if (e instanceof ApiClientError && e.code === "not_found") return;
          throw e;
        },
      );
      live.set(id, p);
      const clear = () => live.delete(id);
      p.then(clear, clear);
      return p;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.machines });
      void qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
};
