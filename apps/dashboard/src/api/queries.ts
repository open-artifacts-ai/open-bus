import {
  type QueryClient,
  type UseQueryResult,
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
  type LinkedApp,
  LinkedAppsResponseSchema,
  type Machine,
  MachinesResponseSchema,
  type Me,
  MeSchema,
  R,
  type Role,
  RolesResponseSchema,
} from "./contract";
import { qk } from "./qk";

export type MachinesData = { machines: Machine[] };

/**
 * The query fields the pages read, as getters. Spreading the query result
 * reads every field and defeats tracked props (a re-render on every
 * fetch-state change); a getter is read only by a consumer that uses it.
 */
const stateOf = (q: UseQueryResult<unknown>) => ({
  get error() {
    return q.error;
  },
  get isPending() {
    return q.isPending;
  },
  get isFetching() {
    return q.isFetching;
  },
  get refetch() {
    return q.refetch;
  },
});
export type AgentsData = { agents: Agent[] };

/** `null` once any call returned 401 (see makeQueryClient): signed out. */
export const useMe = () =>
  useQuery<Me | null>({
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
 * time, so a refetch, a live snapshot or another row's failure can't clobber them.
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
          ? {
              ...m,
              revokedAt: m.revokedAt ?? (at.get(m.id) as string),
              connected: false,
            }
          : m,
      ),
    };
  }, [query.data, key]);
  return Object.assign(stateOf(query), { data });
};

export const useAgents = () =>
  useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.get(R.agents, AgentsResponseSchema, signal),
    staleTime: 10_000,
  });

/**
 * The roster as listed: the agents GET minus agents on machines that are
 * revoked in the overlaid machines data, so a pending revoke takes them off
 * at once. The one rule the nav count and the Agents page share.
 */
export const listedAgents = (
  agents: Agent[],
  machines: Machine[] | undefined,
) => {
  const gone = new Set(
    machines?.filter((m) => m.revokedAt !== null).map((m) => m.id),
  );
  return gone.size === 0
    ? agents
    : agents.filter((a) => !gone.has(a.machineId));
};

/** `useAgents()` with `agents` already through `listedAgents`. */
export const useListedAgents = () => {
  const query = useAgents();
  const machines = useMachines().data?.machines;
  const agents = query.data?.agents;
  const listed = useMemo(
    () => (agents ? listedAgents(agents, machines) : undefined),
    [agents, machines],
  );
  return Object.assign(stateOf(query), { agents: listed });
};

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
    onMutate: () => ({ at: new Date().toISOString() }),
    // Server-confirmed field patch (never a snapshot): the DELETE succeeded or
    // the machine was already gone, so that one row is revoked even if the
    // refetch below fails.
    onSuccess: (_data, id, ctx) => {
      qc.setQueryData<MachinesData>(qk.machines, (old) =>
        old
          ? {
              machines: old.machines.map((m) =>
                m.id === id && m.revokedAt === null
                  ? {
                      ...m,
                      revokedAt: ctx?.at ?? new Date().toISOString(),
                      connected: false,
                    }
                  : m,
              ),
            }
          : old,
      );
    },
    // Returned, so the mutation (and its overlay) stays pending until the refetch lands.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.machines }),
        qc.invalidateQueries({ queryKey: qk.agents }),
      ]),
  });
};

export type RolesData = { roles: Role[] };
export type LinkedAppsData = { apps: LinkedApp[] };

export const useRoles = () =>
  useQuery({
    queryKey: qk.roles,
    queryFn: ({ signal }) => api.get(R.roles, RolesResponseSchema, signal),
    staleTime: 10_000,
  });

export const useLinkedApps = () =>
  useQuery({
    queryKey: qk.linkedApps,
    queryFn: ({ signal }) =>
      api.get(R.linkedApps, LinkedAppsResponseSchema, signal),
    staleTime: 10_000,
  });

/** A DELETE whose target is already gone ended where the caller wanted. */
const deleteOk = (path: string) =>
  api.send("DELETE", path).catch((e) => {
    if (
      e instanceof ApiClientError &&
      (e.status === 404 || e.code === "not_found")
    )
      return;
    throw e;
  });

/**
 * PUT /api/v1/roles/:ns/:role. Not optimistic: the server's 400/409 message
 * is shown inline, so the caller reads the rejection. Role holders ride on
 * agent rows, so agents refetch too.
 */
export const useSetRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { namespace: string; role: string; agentId: string }) =>
      api.send("PUT", R.role(v.namespace, v.role), { agentId: v.agentId }),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.roles }),
        qc.invalidateQueries({ queryKey: qk.agents }),
      ]),
  });
};

/** DELETE /api/v1/roles/:ns/:role. Optimistic; rolls back on failure. */
export const useRemoveRole = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { namespace: string; role: string }) =>
      deleteOk(R.role(v.namespace, v.role)),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.roles });
      const prev = qc.getQueryData<RolesData>(qk.roles);
      qc.setQueryData<RolesData>(qk.roles, (old) =>
        old
          ? {
              roles: old.roles.filter(
                (r) => !(r.namespace === v.namespace && r.role === v.role),
              ),
            }
          : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.roles, ctx.prev);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.roles }),
        qc.invalidateQueries({ queryKey: qk.agents }),
      ]),
  });
};

/** DELETE /api/v1/linked-apps/:aud. Optimistic; rolls back on failure. */
export const useUnlinkApp = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (aud: string) => deleteOk(R.linkedApp(aud)),
    onMutate: async (aud) => {
      await qc.cancelQueries({ queryKey: qk.linkedApps });
      const prev = qc.getQueryData<LinkedAppsData>(qk.linkedApps);
      qc.setQueryData<LinkedAppsData>(qk.linkedApps, (old) =>
        old ? { apps: old.apps.filter((a) => a.aud !== aud) } : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.linkedApps, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.linkedApps }),
  });
};
