import {
  BrandMark,
  Button,
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@ob/ui/shadcn";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import type { Machine } from "../api/contract";
import { useMachines, useRevokeMachine } from "../api/queries";
import {
  CircleAlertIcon,
  CopyIcon,
  InfoIcon,
  RotateCwIcon,
} from "../layout/icons";
import { copy } from "../layout/identity";
import { PageHeader } from "../layout/PageHeader";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { useLiveStatus } from "../live/LiveStatus";
import { MachineRow, statusOf } from "./MachineRow";
import { RevokeDialog, type RevokeTarget } from "./RevokeDialog";

const messageOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong.";

const INSTALL = "npx open-bus";

/** Design D4's table head: uppercase, muted, on secondary; hidden (not gone) below md. */
const HEAD = "h-8 px-4 text-xs tracking-wide text-muted-foreground uppercase";
const SKELETON_WIDTHS = ["w-36", "w-28", "w-32", "w-24"] as const;

function MachinesTable({
  caption,
  busy,
  children,
}: {
  caption: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden rounded-lg py-0 shadow-none">
      <Table aria-busy={busy || undefined} className="max-md:block">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className="bg-secondary max-md:sr-only">
          <TableRow>
            <TableHead className={HEAD}>Machine</TableHead>
            <TableHead className={HEAD}>Added</TableHead>
            <TableHead className={HEAD}>Last used</TableHead>
            <TableHead className={HEAD}>Status</TableHead>
            <TableHead className={HEAD}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        {children}
      </Table>
    </Card>
  );
}

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

/**
 * Every machine with a token for this bus, revoked ones included. The list
 * comes from the GET and the live stream; a dead stream
 * only pauses updates, it never empties the page.
 */
export function Machines() {
  useDocumentTitle("Machines");
  const { data, error, isPending, isFetching, refetch } = useMachines();
  const status = useLiveStatus();
  const revoke = useRevokeMachine();

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<RevokeTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Which machine's dialog is open right now, readable from async callbacks.
  const openId = useRef<string | null>(null);
  // Revokes this page started and hasn't seen settle. A ref, so a second
  // click landing before the re-render is still ignored.
  const inFlight = useRef(new Set<string>());

  const ask = (m: Machine) => {
    openId.current = m.id;
    setTarget({ id: m.id, label: m.label });
    setFailure(null);
    setOpen(true);
  };
  const close = () => {
    openId.current = null;
    setOpen(false);
  };

  // One pattern: success always toasts; a failure shows inline while this
  // machine's dialog is still open, and as a destructive toast once it isn't.
  const confirm = () => {
    if (!target || inFlight.current.has(target.id)) return;
    const { id, label } = target;
    inFlight.current.add(id);
    setFailure(null);
    const settle = () => inFlight.current.delete(id);
    revoke.mutateAsync(id).then(
      () => {
        settle();
        toast.success(
          <>
            <bdi className="font-mono">{label}</bdi> revoked
          </>,
          {
            id: `revoke-${id}`,
            description: "Its sockets closed and its agents left the roster.",
            duration: 8000,
          },
        );
        if (openId.current === id) close();
      },
      (e: unknown) => {
        settle();
        // A 401 signs the owner out (makeQueryClient); nothing to say here.
        if (e instanceof ApiClientError && e.code === "unauthorized") return;
        if (openId.current === id) setFailure(messageOf(e));
        else
          toast.error(`Couldn't revoke ${label}`, {
            description: messageOf(e),
            duration: 8000,
          });
      },
    );
  };

  const busy = revoke.isPending && revoke.variables === target?.id;
  const machines = data?.machines;

  // The live stream may remove or revoke the machine under an open dialog;
  // confirming would then report a revoke that never happened. Our own
  // pending revoke also shows as revoked (the overlay), so it is exempt.
  const current = machines?.find((m) => m.id === target?.id);
  const stale =
    open &&
    target !== null &&
    machines !== undefined &&
    !inFlight.current.has(target.id) &&
    (current === undefined || current.revokedAt !== null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close is stable in effect (refs and setters)
  useEffect(() => {
    if (stale) close();
  }, [stale]);
  // Counted from the rows as shown, pending overlay included.
  const live = machines?.filter((m) => statusOf(m) === "live").length ?? 0;
  const loading = isPending && !error;

  return (
    <>
      <PageHeader title="Machines">
        {/* Adding a machine happens in a terminal, not here. */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => copy(INSTALL)}
        >
          <CopyIcon />
          Copy <span className="font-mono">{INSTALL}</span>
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {machines && machines.length > 0 && (
              <>
                <Mono>{machines.length}</Mono>{" "}
                {machines.length === 1 ? "machine" : "machines"} ·{" "}
                <span
                  data-muted={status === "paused" ? "true" : undefined}
                  className={
                    status === "paused" ? "text-muted-foreground" : undefined
                  }
                >
                  <span
                    className={
                      status === "paused"
                        ? "font-mono"
                        : "font-mono text-foreground"
                    }
                  >
                    {live}
                  </span>{" "}
                  live
                </span>
              </>
            )}
            {machines && machines.length === 0 && "No machines"}
            {loading && "Loading machines"}
          </p>
          {/* Always mounted, so screen readers announce the text when it appears. */}
          <span role="status" className="text-xs text-muted-foreground">
            {status === "paused" ? "Live updates paused" : ""}
          </span>
        </div>

        {machines && machines.length > 0 && (
          <>
            <Card
              role="note"
              className="flex-row items-start gap-3 rounded-lg border-transparent bg-(--ob-accent-soft) px-4 py-3 shadow-none"
            >
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-(--ob-accent-fg)" />
              <p className="text-sm">
                Adding a machine: run{" "}
                <code className="font-mono text-[13px]">{INSTALL}</code> on it
                and approve it in the browser that opens.
              </p>
            </Card>
            <MachinesTable caption="Machines connected to your bus">
              <TableBody className="max-md:block">
                {machines.map((m) => (
                  <MachineRow
                    key={m.id}
                    machine={m}
                    onRevoke={ask}
                    paused={status === "paused"}
                  />
                ))}
              </TableBody>
            </MachinesTable>
          </>
        )}

        {loading && (
          <MachinesTable caption="Loading machines" busy>
            <TableBody aria-hidden="true" className="max-md:block">
              {SKELETON_WIDTHS.map((w) => (
                <TableRow
                  key={w}
                  className="h-12 max-md:grid max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-2 max-md:px-4 max-md:py-3"
                >
                  <TableCell className="w-full px-4 max-md:p-0">
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 rounded-full" />
                      <Skeleton className={`h-3.5 ${w}`} />
                    </div>
                  </TableCell>
                  <TableCell className="px-4 max-md:col-start-1 max-md:row-start-2 max-md:p-0">
                    <Skeleton className="h-3.5 w-20" />
                  </TableCell>
                  <TableCell className="px-4 max-md:col-start-2 max-md:row-start-2 max-md:p-0 max-md:justify-self-end">
                    <Skeleton className="h-3.5 w-16" />
                  </TableCell>
                  <TableCell className="px-4 max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </TableCell>
                  <TableCell className="px-4 max-md:col-span-2 max-md:p-0">
                    <div className="flex justify-end max-md:justify-start">
                      <Skeleton className="h-7 w-20 rounded-full" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </MachinesTable>
        )}

        {machines && machines.length === 0 && (
          <Card className="items-center gap-2 rounded-lg px-4 py-8 text-center shadow-none">
            <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <BrandMark className="size-5" />
            </div>
            <h2 className="mt-2 text-base font-semibold tracking-[-0.01em]">
              No machines yet
            </h2>
            <p className="mb-2 max-w-[380px] text-sm text-muted-foreground">
              Run{" "}
              <code className="font-mono text-[13px] text-foreground">
                {INSTALL}
              </code>{" "}
              on a machine to add it. It opens a browser approval and connects.
            </p>
            <div className="flex items-center gap-1 rounded-md border bg-secondary py-1 pr-1 pl-3">
              <code className="font-mono text-xs">{INSTALL}</code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Copy command"
                onClick={() => copy(INSTALL)}
              >
                <CopyIcon />
              </Button>
            </div>
            <Button className="mt-2" onClick={() => copy(INSTALL)}>
              <CopyIcon />
              Copy <span className="font-mono">{INSTALL}</span>
            </Button>
          </Card>
        )}

        {error && !machines && (
          <Card
            role="alert"
            className="flex-row items-start gap-3 rounded-lg border-transparent bg-(--ob-danger-soft) px-4 py-3 shadow-none max-sm:flex-wrap"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-(--ob-danger)" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Couldn't load machines</p>
              <p className="text-muted-foreground">
                The bus answered with an error. Nothing changed.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="max-sm:ml-7"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RotateCwIcon />
              Retry
            </Button>
          </Card>
        )}
      </div>

      <RevokeDialog
        open={open}
        target={target}
        busy={busy}
        error={failure}
        onConfirm={confirm}
        onClose={close}
      />
    </>
  );
}
