import { Badge } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";

const WORD: Record<Agent["state"], string> = {
  live: "Live",
  queued: "Queued",
};

/** Live is success, queued is waiting (warning); paused mutes both. */
const DOT: Record<Agent["state"], string> = {
  live: "size-2 rounded-full bg-(--ob-success)",
  queued: "size-2 rounded-full bg-(--ob-warning)",
};

/**
 * The roster state of one agent: "Live" (machine connected) or "Queued"
 * (machine offline, session open, mail waits). Isolated so Design's
 * StatusBadge (`@ob/ui/composites`, D5) can replace it without touching the
 * page. The badge word never changes; while updates are paused (`asOf` set)
 * the badge is muted and its label says how old the claim is.
 */
export function LiveChip({
  name,
  machine,
  state,
  asOf,
}: {
  name: string;
  machine: string;
  state: Agent["state"];
  asOf: string | null;
}) {
  return (
    <Badge
      variant="outline"
      role="img"
      aria-label={
        asOf
          ? `${name} on ${machine}, ${state} as of ${asOf}`
          : `${name} on ${machine} is ${state}`
      }
      className={
        asOf ? "text-muted-foreground opacity-60" : "text-muted-foreground"
      }
    >
      <span
        aria-hidden="true"
        className={
          asOf ? "size-2 rounded-full bg-muted-foreground" : DOT[state]
        }
      />
      {WORD[state]}
    </Badge>
  );
}
