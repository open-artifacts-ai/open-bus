import { Badge, Button } from "@ob/ui/shadcn";
import { useLiveStatus } from "../live/LiveStatus";

/**
 * Always mounted (role=status), so the paused chip is announced when it
 * appears. Connecting renders nothing: no "paused" flash on first load.
 */
export function LiveUpdates({ onRetry }: { onRetry(): void }) {
  const status = useLiveStatus();
  return (
    <div role="status" className="flex items-center gap-2">
      {status === "paused" && (
        <>
          <Badge variant="outline" className="text-muted-foreground">
            Live updates paused
          </Badge>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </>
      )}
    </div>
  );
}
