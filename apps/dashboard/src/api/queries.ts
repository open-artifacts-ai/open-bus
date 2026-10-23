import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

export const useMachines = () =>
  useQuery({
    queryKey: qk.machines,
    queryFn: ({ signal }) =>
      api.get(R.machines, MachinesResponseSchema, signal),
    staleTime: 10_000,
  });

export const useAgents = () =>
  useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.get(R.agents, AgentsResponseSchema, signal),
    staleTime: 10_000,
  });

/**
 * DELETE /api/v1/machines/:id. Optimistic: the row shows as revoked at once.
 * A 404 means the machine was already revoked (another tab, a double click),
 * which is the same end state, so it is success rather than an error.
 * Toasts are the caller's job (read `error` / `isSuccess`).
 */
export const useRevokeMachine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await api.send("DELETE", R.machine(id));
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 404) return;
        throw e;
      }
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.machines });
      const before = qc.getQueryData<MachinesData>(qk.machines);
      const at = new Date().toISOString();
      if (before)
        qc.setQueryData<MachinesData>(qk.machines, {
          machines: before.machines.map((m) =>
            m.id === id ? { ...m, revokedAt: at } : m,
          ),
        });
      return { before };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.before) qc.setQueryData(qk.machines, ctx.before);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.machines });
      void qc.invalidateQueries({ queryKey: qk.agents });
    },
  });
};
