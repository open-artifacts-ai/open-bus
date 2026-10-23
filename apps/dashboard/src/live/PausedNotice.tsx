import { Button, Card } from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { CirclePauseIcon, RotateCwIcon } from "../layout/icons";
import { useLiveRetry } from "./LiveStatus";
import { usePaused } from "./usePaused";

/**
 * Decision 4's paused banner: "Live updates paused. Showing the {list} as of
 * {time}." with Retry. The status region is always mounted and holds only
 * the text, so the change is announced and Retry isn't re-read with it.
 * Retry reconnects a parked stream (its greeting refreshes the lists);
 * otherwise it refetches `queryKey` once, and never while a fetch runs.
 */
export function PausedNotice({
  list,
  queryKey,
  fetching,
  refetch,
}: {
  list: string;
  queryKey: readonly unknown[];
  fetching: boolean;
  refetch(): unknown;
}) {
  const qc = useQueryClient();
  const reconnect = useLiveRetry();
  const { since, asOf } = usePaused();
  const retry = () => {
    if (qc.isFetching({ queryKey }) > 0) return;
    if (!reconnect()) void refetch();
  };
  return (
    <Card
      className={
        since
          ? "flex-row items-start gap-3 rounded-lg border-transparent bg-secondary px-4 py-3 shadow-none max-sm:flex-wrap"
          : "contents"
      }
    >
      {since && (
        <CirclePauseIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <p
        role="status"
        className={
          since ? "min-w-0 flex-1 text-sm text-muted-foreground" : "sr-only"
        }
      >
        {since && (
          <>
            Live updates paused. Showing the {list} as of{" "}
            <time dateTime={since.toISOString()}>{asOf}</time>.
          </>
        )}
      </p>
      {since && (
        <Button
          variant="outline"
          size="sm"
          className="max-sm:ml-7"
          disabled={fetching}
          onClick={retry}
        >
          <RotateCwIcon />
          Retry
        </Button>
      )}
    </Card>
  );
}
