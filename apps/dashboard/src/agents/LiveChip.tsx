import { Badge } from "@ob/ui/shadcn";

/**
 * The live indicator for one agent. Isolated so Design's StatusBadge
 * (`@ob/ui/composites`, D5) can replace it without touching the page.
 */
export function LiveChip({ name, live }: { name: string; live: boolean }) {
  return (
    <Badge
      variant="outline"
      role="img"
      aria-label={`${name} is ${live ? "live" : "offline"}`}
      className="text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={
          live
            ? "size-2 rounded-full bg-(--ob-success)"
            : "size-2 rounded-full border border-muted-foreground"
        }
      />
      {live ? "Live" : "Offline"}
    </Badge>
  );
}
