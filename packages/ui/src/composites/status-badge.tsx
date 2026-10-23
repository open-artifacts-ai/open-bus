import type * as React from "react";
import { cn } from "#shadcn/lib/utils";
import { Badge } from "#shadcn/ui/badge";

export type Status = "live" | "offline" | "revoked" | "queued" | "closed";

// Never color alone: each status has its own word, and revoked's dot is hollow.
const STATUS: Record<Status, { word: string; badge: string; dot: string }> = {
  live: {
    word: "Live",
    badge: "bg-(--ob-success-soft) text-(--ob-success-fg)",
    dot: "bg-current",
  },
  offline: {
    word: "Offline",
    badge: "bg-secondary text-secondary-foreground",
    dot: "bg-(--ob-border-strong)",
  },
  revoked: {
    word: "Revoked",
    badge: "bg-(--ob-danger-soft) text-(--ob-danger)",
    dot: "border-[1.5px] border-current bg-transparent",
  },
  queued: {
    word: "Queued",
    badge: "bg-(--ob-warning-soft) text-(--ob-warning)",
    dot: "bg-current",
  },
  closed: {
    word: "Closed",
    badge: "bg-secondary text-secondary-foreground",
    dot: "bg-(--ob-border-strong)",
  },
};

/** A shadcn Badge with a 6px dot and a word: Live, Offline, Revoked, Queued, Closed. */
export function StatusBadge({
  status,
  className,
  ...props
}: Omit<
  React.ComponentProps<typeof Badge>,
  "variant" | "children" | "asChild"
> & {
  status: Status;
}) {
  const s = STATUS[status];
  return (
    <Badge
      variant="secondary"
      data-status={status}
      className={cn("gap-1.5", s.badge, className)}
      {...props}
    >
      <span
        data-slot="status-badge-dot"
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", s.dot)}
      />
      {s.word}
    </Badge>
  );
}
