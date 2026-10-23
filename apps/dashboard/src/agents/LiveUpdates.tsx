import { Button } from "@ob/ui/shadcn";

/**
 * The paused banner. The role=status region is always mounted (so the text is
 * announced when it appears) and holds only the text; Retry sits beside it.
 * Connecting and live render nothing: no "paused" flash on first load.
 */
export function LiveUpdates({
  asOf,
  retrying,
  onRetry,
}: {
  asOf: string | null;
  retrying: boolean;
  onRetry(): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 empty:hidden">
      <p role="status" className="text-sm text-muted-foreground">
        {asOf ? `Live updates paused. Showing the roster as of ${asOf}.` : ""}
      </p>
      {asOf && (
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
