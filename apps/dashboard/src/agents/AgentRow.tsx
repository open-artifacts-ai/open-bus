import { StatusBadge } from "@ob/ui/composites";
import { Badge, TableCell, TableRow } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";
import { updated } from "./roster";

const KIND: Record<Agent["kind"], string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};

/** Design D5's presence dot; the roster's paused flag greys it. */
const DOT: Record<Agent["state"], string> = {
  live: "bg-(--ob-success)",
  queued: "bg-(--ob-warning)",
};

/** Paused mutes both badges the same grey; the word never changes. */
const MUTED =
  "group-data-[paused=true]/roster:bg-secondary group-data-[paused=true]/roster:text-muted-foreground";

/** Design D5's row; below md it stacks into a two-column card. */
export const ROW =
  "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1.5 max-md:px-4 max-md:py-3";

/**
 * One agent: presence dot and name, kind, machine, StatusBadge (Live or
 * Queued, from `Agent.state`) and when it last changed. A global agent gets
 * the accent `global` badge; its home namespace is never shown. `asOf` is set while live updates are paused: the
 * badge's label then says how old the claim is.
 */
export function AgentRow({
  agent,
  asOf,
}: {
  agent: Agent;
  asOf: string | null;
}) {
  const { name, machineLabel: machine, state } = agent;
  return (
    <TableRow className={ROW}>
      <TableCell className="w-full min-w-0 whitespace-normal px-4 py-2 max-md:p-0">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            aria-hidden="true"
            className={`mt-[7px] size-1.5 shrink-0 rounded-full ${DOT[state]} group-data-[paused=true]/roster:bg-(--ob-border-strong)`}
          />
          <div className="grid min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <bdi className="font-mono font-medium [overflow-wrap:anywhere]">
                {name}
              </bdi>
              {agent.global && (
                <Badge
                  variant="secondary"
                  className="font-mono font-medium bg-(--ob-accent-soft) text-(--ob-accent-fg)"
                >
                  global
                </Badge>
              )}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="px-4 md:min-w-32 max-md:col-start-1 max-md:row-start-2 max-md:p-0 max-md:pl-4">
        {KIND[agent.kind] ?? agent.kind}
      </TableCell>
      <TableCell className="min-w-0 whitespace-normal px-4 md:min-w-44 max-md:col-span-2 max-md:row-start-3 max-md:p-0 max-md:pl-4">
        <span aria-hidden="true" className="text-muted-foreground md:hidden">
          Machine{" "}
        </span>
        <bdi className="font-mono [overflow-wrap:anywhere]">{machine}</bdi>
      </TableCell>
      <TableCell className="px-4 md:min-w-28 max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
        <StatusBadge
          status={state}
          role="img"
          aria-label={
            asOf
              ? `${name} on ${machine}, ${state} as of ${asOf}`
              : `${name} on ${machine} is ${state}`
          }
          className={MUTED}
        />
      </TableCell>
      <TableCell className="px-4 text-muted-foreground md:min-w-24 max-md:col-start-2 max-md:row-start-2 max-md:p-0 max-md:text-right">
        {updated(agent.updatedAt)}
      </TableCell>
    </TableRow>
  );
}
