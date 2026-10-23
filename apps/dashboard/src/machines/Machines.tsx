import {
  Button,
  Skeleton,
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@ob/ui/shadcn";
import { useRef, useState } from "react";
import { ApiClientError } from "../api/client";
import type { Machine } from "../api/contract";
import { useMachines, useRevokeMachine } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { useLiveStatus } from "../live/LiveStatus";
import { MachineRow } from "./MachineRow";
import { RevokeDialog, type RevokeTarget } from "./RevokeDialog";

const messageOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong.";

/**
 * Every machine with a token for this bus, revoked ones included (struck
 * through). The list comes from the GET and the live stream; a dead stream
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
    if (!target) return;
    const { id, label } = target;
    setFailure(null);
    revoke.mutateAsync(id).then(
      () => {
        toast.success("Machine revoked", {
          description: "Its agents left the roster.",
        });
        if (openId.current === id) close();
      },
      (e: unknown) => {
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
  const active = machines?.filter((m) => m.revokedAt === null).length ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-(length:--ob-text-xl) font-semibold">Machines</h1>
        {status === "paused" && (
          <span role="status" className="text-xs text-muted-foreground">
            Live updates paused
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Every machine with a token for this bus.
        {machines && machines.length > 0 && (
          <> {active === 1 ? "1 is active." : `${active} are active.`}</>
        )}
      </p>

      {isPending && !error && (
        <section
          aria-label="Loading machines"
          aria-busy="true"
          className="mt-6 grid gap-3"
        >
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-2/3" />
        </section>
      )}

      {error && !machines && (
        <div
          role="alert"
          className="mt-6 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <p className="text-sm font-medium">Couldn't load your machines.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {messageOf(error)}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            Try again
          </Button>
        </div>
      )}

      {machines && machines.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed p-6">
          <p className="font-medium">No machines yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            On the machine you want to connect, run:
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-sm">
            <code className="font-mono">npx open-bus</code>
          </pre>
        </div>
      )}

      {machines && machines.length > 0 && (
        <Table className="mt-4">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Machine</TableHead>
              <TableHead className="max-sm:hidden">Activity</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Status</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((m) => (
              <MachineRow key={m.id} machine={m} onRevoke={ask} />
            ))}
          </TableBody>
        </Table>
      )}

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
