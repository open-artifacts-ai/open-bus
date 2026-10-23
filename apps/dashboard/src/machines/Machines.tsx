import {
  Button,
  Card,
  Skeleton,
  TableBody,
  TableCell,
  TableRow,
  toast,
} from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import type { Machine } from "../api/contract";
import { qk } from "../api/qk";
import { useMachines, useRevokeMachine } from "../api/queries";
import { isSignedIn } from "../api/queryClient";
import { messageOf } from "../format";
import { CopyIcon, InfoIcon } from "../layout/icons";
import { copy } from "../layout/identity";
import { PageHeader } from "../layout/PageHeader";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { PausedNotice } from "../live/PausedNotice";
import { usePaused } from "../live/usePaused";
import { EmptyCard } from "../ui/EmptyCard";
import { LiveCount } from "../ui/LiveCount";
import { LoadError } from "../ui/LoadError";
import { Mono } from "../ui/Mono";
import { TableFrame } from "../ui/TableFrame";
import { MachineRow, statusOf } from "./MachineRow";
import { RevokeDialog, type RevokeTarget } from "./RevokeDialog";

const INSTALL = "npx open-bus";

const HEADS = [
  "Machine",
  "Added",
  "Last used",
  "Status",
  <span key="actions" className="sr-only">
    Actions
  </span>,
];
const SKELETON_WIDTHS = ["w-36", "w-28", "w-32", "w-24"] as const;

/**
 * Every machine with a token for this bus, revoked ones included. The list
 * comes from the GET and the live stream; a dead stream
 * only pauses updates, it never empties the page.
 */
export function Machines() {
  useDocumentTitle("Machines");
  const { data, error, isPending, isFetching, refetch } = useMachines();
  const { paused, asOf } = usePaused();
  const revoke = useRevokeMachine();
  const qc = useQueryClient();

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
        // Signed out meanwhile: the sign-in screen gets no revoke feedback.
        if (!isSignedIn(qc)) return;
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
        if (!isSignedIn(qc)) return;
        if (e instanceof ApiClientError && e.code === "unauthorized") return;
        if (openId.current === id) setFailure(messageOf(e));
        else
          toast.error(
            <>
              Couldn't revoke <bdi className="font-mono">{label}</bdi>
            </>,
            { description: messageOf(e), duration: 8000 },
          );
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
        <PausedNotice
          list="machine list"
          queryKey={qk.machines}
          fetching={isFetching}
          refetch={refetch}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p data-summary className="text-sm text-muted-foreground">
            {machines && machines.length > 0 && (
              <>
                <Mono>{machines.length}</Mono>{" "}
                {machines.length === 1 ? "machine" : "machines"}{" "}
                <LiveCount n={live} muted={paused} />
              </>
            )}
            {machines && machines.length === 0 && "No machines"}
            {loading && "Loading machines"}
          </p>
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
            <TableFrame caption="Machines connected to your bus" heads={HEADS}>
              <TableBody className="max-md:block">
                {machines.map((m) => (
                  <MachineRow
                    key={m.id}
                    machine={m}
                    onRevoke={ask}
                    muted={asOf}
                  />
                ))}
              </TableBody>
            </TableFrame>
          </>
        )}

        {loading && (
          <TableFrame caption="Loading machines" heads={HEADS} busy>
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
          </TableFrame>
        )}

        {machines && machines.length === 0 && (
          <EmptyCard
            title="No machines yet"
            help={
              <>
                Run{" "}
                <code className="font-mono text-[13px] text-foreground">
                  {INSTALL}
                </code>{" "}
                on a machine to add it. It opens a browser approval and
                connects.
              </>
            }
          >
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
          </EmptyCard>
        )}

        {error && !machines && (
          <LoadError
            title="Couldn't load machines"
            suffix="Nothing changed."
            error={error}
            fetching={isFetching}
            onRetry={() => void refetch()}
          />
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
