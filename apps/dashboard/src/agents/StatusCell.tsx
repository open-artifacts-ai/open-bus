import { Badge } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";
import { ago } from "../format";

/** Labels for the known states; a newer state shows as its own token. */
const STATE: Record<string, string> = {
  working: "Working",
  idle: "Idle",
  blocked: "Blocked",
  waiting_on_owner: "Waiting on you",
};

const stateLabel = (s: string) => (Object.hasOwn(STATE, s) ? STATE[s] : s);

/**
 * What the agent says about itself: a dashed, unfilled pill (never an
 * attested badge), its label as text, and when it said so. Never fact.
 */
export function StatusCell({ agent }: { agent: Agent }) {
  const { status, statusLabel, statusAt } = agent;
  if (!status)
    return (
      <span role="img" aria-label="No status" className="text-muted-foreground">
        None
      </span>
    );
  return (
    <div className="grid min-w-0 gap-0.5">
      <Badge
        variant="outline"
        data-variant="agent-says"
        className="w-fit border-dashed bg-transparent [overflow-wrap:anywhere]"
      >
        {stateLabel(status)}
      </Badge>
      {(statusLabel || statusAt) && (
        <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">
          {statusLabel}
          {statusAt && (
            <span className="text-xs text-muted-foreground">
              {statusLabel && " · "}
              {ago(statusAt)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}
