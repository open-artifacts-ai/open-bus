import type { Agent, Machine } from "@ob/shared";
import type { AgentRow, MachineRow } from "./rows.js";

export type { Agent, Machine };

/** Epoch ms to ISO 8601 (UTC, `Z`); null stays null. */
export function iso(ms: number): string;
export function iso(ms: number | null): string | null;
export function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** A hub machine row as `MachineSchema` (strict) describes it. */
export const machineDto = (m: MachineRow): Machine => ({
  id: m.id,
  label: m.label,
  createdAt: iso(m.createdAt),
  lastUsed: iso(m.lastUsedAt),
  revokedAt: iso(m.revokedAt),
  connected: m.revokedAt === null && m.connected,
});

/** An open agent row joined with its (unrevoked) machine's label. */
export type AgentWithMachine = AgentRow & { machineLabel: string };

/**
 * An open agent as `AgentSchema` (strict) describes it. `connected` is whether
 * its machine holds a daemon socket: live if so, queued otherwise. Callers
 * omit closed agents and agents of revoked machines.
 */
export const agentDto = (a: AgentWithMachine, connected: boolean): Agent => ({
  id: a.id,
  namespace: a.namespace,
  name: a.name,
  kind: a.kind as Agent["kind"],
  machineId: a.machineId,
  machineLabel: a.machineLabel,
  global: a.global === 1,
  state: connected ? "live" : "queued",
  updatedAt: iso(a.updatedAt),
});
