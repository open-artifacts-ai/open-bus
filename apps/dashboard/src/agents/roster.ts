import type { Agent } from "../api/contract";
import { ago } from "../machines/MachineRow";

/** The view key of the Global agents section. */
export const GLOBAL = "\u0000global";

export type Filter = "all" | "live" | "queued";

const RANK: Record<Agent["state"], number> = { live: 0, queued: 1 };
const byLiveThenName = (x: Agent, y: Agent) =>
  RANK[x.state] - RANK[y.state] || x.name.localeCompare(y.name);

/** Namespaces with a table: those of the non-global agents, alphabetical. */
export const namespacesOf = (agents: Agent[]) =>
  [...new Set(agents.filter((a) => !a.global).map((a) => a.namespace))].sort(
    (a, b) => a.localeCompare(b),
  );

/**
 * The roster split as the page shows it: each namespace's non-global agents,
 * and every global agent once, in its own list (never under a namespace).
 * Each list is live first, then queued, then by name.
 */
export function split(agents: Agent[]) {
  const byNs = new Map<string, Agent[]>();
  const global: Agent[] = [];
  for (const a of agents) {
    if (a.global) global.push(a);
    else byNs.set(a.namespace, [...(byNs.get(a.namespace) ?? []), a]);
  }
  for (const [ns, list] of byNs) byNs.set(ns, list.sort(byLiveThenName));
  return { byNs, global: global.sort(byLiveThenName) };
}

/** The rows a filter keeps. */
export const filtered = (agents: Agent[], f: Filter) =>
  f === "all" ? agents : agents.filter((a) => a.state === f);

export const liveCount = (agents: Agent[]) =>
  agents.filter((a) => a.state === "live").length;

/** "10:42 AM": when a paused roster was last current. */
export const clock = (d: Date) =>
  new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
    d,
  );

/** Design D5's Updated column: "now", "3 min ago", "3 h ago", then the date. */
export const updated = (iso: string, now = Date.now()) => {
  const s = ago(iso, now);
  return s === "just now" ? "now" : s;
};
