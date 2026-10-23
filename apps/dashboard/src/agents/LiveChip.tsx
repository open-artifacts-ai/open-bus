import { Badge } from "@ob/ui/shadcn";

/**
 * The live indicator for one agent. Isolated so Design's StatusBadge
 * (`@ob/ui/composites`, D5) can replace it without touching the page.
 * The badge word never changes; while updates are paused (`asOf` set) the
 * badge is muted and its label says how old the claim is.
 */
export function LiveChip({
  name,
  machine,
  live,
  asOf,
}: {
  name: string;
  machine: string;
  live: boolean;
  asOf: string | null;
}) {
  const state = live ? "live" : "offline";
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
          live && !asOf
            ? "size-2 rounded-full bg-(--ob-success)"
            : live
              ? "size-2 rounded-full bg-muted-foreground"
              : "size-2 rounded-full border border-muted-foreground"
        }
      />
      {live ? "Live" : "Offline"}
    </Badge>
  );
}
