import { Badge } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";
import { LiveChip } from "./LiveChip";

const KIND: Record<Agent["kind"], string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};

/** One agent: name, global badge, kind and machine, live indicator. */
export function AgentRow({ agent }: { agent: Agent }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{agent.name}</span>
          {agent.global && <Badge variant="secondary">global</Badge>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {KIND[agent.kind] ?? agent.kind} · {agent.machineLabel}
        </div>
      </div>
      <LiveChip name={agent.name} live={agent.live} />
    </li>
  );
}
