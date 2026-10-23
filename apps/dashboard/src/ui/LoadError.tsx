import { Button, Card } from "@ob/ui/shadcn";
import type { ClientErrorCode } from "../api/client";
import { CircleAlertIcon, RotateCwIcon } from "../layout/icons";

/** What went wrong, by the error's code: unreachable, or an error answer. */
const detailOf = (code: ClientErrorCode | undefined) =>
  code === "network"
    ? "Couldn't reach the bus."
    : "The bus answered with an error.";

/**
 * A list that failed to load (Design's danger banner, with Retry). The title
 * is the page's own; the detail comes from `error.code`, then `suffix`.
 */
export function LoadError({
  title,
  error,
  suffix,
  fetching,
  onRetry,
}: {
  title: string;
  error: unknown;
  suffix?: string;
  fetching: boolean;
  onRetry(): void;
}) {
  const code = (error as { code?: ClientErrorCode } | null)?.code;
  return (
    <Card
      role="alert"
      className="flex-row items-start gap-3 rounded-lg border-transparent bg-(--ob-danger-soft) px-4 py-3 shadow-none max-sm:flex-wrap"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-(--ob-danger)" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">
          {suffix ? `${detailOf(code)} ${suffix}` : detailOf(code)}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="max-sm:ml-7"
        disabled={fetching}
        onClick={onRetry}
      >
        <RotateCwIcon />
        Retry
      </Button>
    </Card>
  );
}
