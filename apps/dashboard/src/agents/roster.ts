import type { Agent } from "../api/contract";

/** Namespaces alphabetical; within one, live first, then by name. */
export function groupByNamespace(agents: Agent[]): [string, Agent[]][] {
  const by = new Map<string, Agent[]>();
  for (const a of agents)
    by.set(a.namespace, [...(by.get(a.namespace) ?? []), a]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, list]) => [
      ns,
      [...list].sort(
        (x, y) =>
          Number(y.live) - Number(x.live) || x.name.localeCompare(y.name),
      ),
    ]);
}

/** Every namespace in the roster, alphabetical. */
export const namespacesOf = (agents: Agent[]) =>
  [...new Set(agents.map((a) => a.namespace))].sort((a, b) =>
    a.localeCompare(b),
  );

/**
 * The agents a namespace view shows: that namespace's, plus every global
 * agent (the same rule as `GET /agents?namespace=`). No namespace means all.
 */
export const inView = (agents: Agent[], namespace: string | null) =>
  namespace === null
    ? agents
    : agents.filter((a) => a.namespace === namespace || a.global);
