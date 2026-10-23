import type { Agent } from "../api/contract";

/** The region name of the group that holds every global agent. */
export const GLOBAL_GROUP = "Global agents";

const RANK: Record<Agent["state"], number> = { live: 0, queued: 1 };
const byLiveThenName = (x: Agent, y: Agent) =>
  RANK[x.state] - RANK[y.state] || x.name.localeCompare(y.name);

/** Namespaces that have a group: those of the non-global agents, alphabetical. */
export const namespacesOf = (agents: Agent[]) =>
  [...new Set(agents.filter((a) => !a.global).map((a) => a.namespace))].sort(
    (a, b) => a.localeCompare(b),
  );

/**
 * The groups a view shows. Each namespace group holds only that namespace's
 * non-global agents; global agents sit in one "Global agents" group, last, in
 * every view (the same rule as `GET /agents?namespace=`). Within a group,
 * live first, then queued, then by name. `null` means every namespace.
 */
export function groupsFor(
  agents: Agent[],
  namespace: string | null,
): [string, Agent[]][] {
  const by = new Map<string, Agent[]>();
  const global: Agent[] = [];
  for (const a of agents) {
    if (a.global) global.push(a);
    else if (namespace === null || a.namespace === namespace)
      by.set(a.namespace, [...(by.get(a.namespace) ?? []), a]);
  }
  const groups: [string, Agent[]][] = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, list]) => [ns, [...list].sort(byLiveThenName)]);
  if (global.length > 0)
    groups.push([GLOBAL_GROUP, [...global].sort(byLiveThenName)]);
  return groups;
}

/** "10:42 AM": when a paused roster was last current. */
export const clock = (d: Date) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    d,
  );
