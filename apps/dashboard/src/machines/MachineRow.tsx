import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  TableCell,
  TableRow,
} from "@ob/ui/shadcn";
import type { CSSProperties } from "react";
import type { Machine } from "../api/contract";
import { ago, day } from "../format";
import { CopyIcon, EllipsisIcon } from "../layout/icons";
import { copy, hue, initials } from "../layout/identity";
import { ClaimBadge } from "../ui/ClaimBadge";

/** Design D4's row; below md it stacks into a two-column card. */
const ROW =
  "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-2 max-md:px-4 max-md:py-3";

export type MachineStatus = "live" | "offline" | "revoked";

/** Revoked wins: a revoked machine is never connected, whatever a stale flag says. */
export const statusOf = (m: Machine): MachineStatus =>
  m.revokedAt !== null ? "revoked" : m.connected ? "live" : "offline";

/**
 * One machine. Its badge is Live (daemon holds its hub socket), Offline or
 * Revoked; revoked machines stay listed with the revoke date and no actions.
 * `muted` is the as-of time while live updates are paused: the Live/Offline
 * claim is stale then (ClaimBadge); Revoked is a fact and stays as is.
 * The Revoke button carries `data-machine-id` so the dialog can hand focus
 * back to it on close.
 */
export function MachineRow({
  machine,
  onRevoke,
  muted,
}: {
  machine: Machine;
  onRevoke(m: Machine): void;
  muted: string | null;
}) {
  const { id, label, createdAt, lastUsed, revokedAt } = machine;
  const status = statusOf(machine);
  return (
    <TableRow className={ROW}>
      <TableCell className="w-full min-w-0 whitespace-normal px-4 py-2 max-md:p-0">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            aria-hidden="true"
            style={{ "--hue": hue(id) } as CSSProperties}
          >
            <AvatarFallback className="bg-[hsl(var(--hue)_45%_30%)] text-[13px] font-semibold text-white">
              {initials(label)}
            </AvatarFallback>
          </Avatar>
          <div className="grid min-w-0">
            <bdi className="font-mono font-medium [overflow-wrap:anywhere]">
              {label}
            </bdi>
            <span className="font-mono text-xs text-muted-foreground">
              <span className="sr-only">Machine id </span>
              {`${id.slice(0, 8)}…`}
            </span>
          </div>
        </div>
      </TableCell>
      <TableCell className="px-4 max-md:col-start-1 max-md:row-start-2 max-md:p-0">
        <span aria-hidden="true" className="text-muted-foreground md:hidden">
          Added{" "}
        </span>
        {day(createdAt)}
      </TableCell>
      {lastUsed ? (
        <TableCell className="px-4 max-md:col-start-2 max-md:row-start-2 max-md:p-0 max-md:text-right">
          <span aria-hidden="true" className="text-muted-foreground md:hidden">
            Last used{" "}
          </span>
          {ago(lastUsed)}
        </TableCell>
      ) : (
        <TableCell className="px-4 text-muted-foreground max-md:col-start-2 max-md:row-start-2 max-md:p-0 max-md:text-right">
          <span aria-hidden="true" className="md:hidden">
            Last used{" "}
          </span>
          Never
        </TableCell>
      )}
      <TableCell className="px-4 max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
        <ClaimBadge
          status={status}
          subject={label}
          muted={status === "revoked" ? null : muted}
        />
      </TableCell>
      {revokedAt !== null ? (
        <TableCell className="px-4 text-right text-xs text-muted-foreground max-md:col-span-2 max-md:p-0 max-md:text-left">
          Revoked {day(revokedAt)}
        </TableCell>
      ) : (
        <TableCell className="px-4 max-md:col-span-2 max-md:p-0">
          <div className="flex items-center justify-end gap-1 max-md:justify-start">
            <Button
              variant="destructive"
              size="sm"
              data-machine-id={id}
              aria-label={`Revoke ${label}`}
              className="h-7 rounded-full border border-transparent bg-(--ob-danger-soft) px-3 text-(--ob-danger) hover:border-(--ob-danger) hover:bg-(--ob-danger-soft)"
              onClick={() => onRevoke(machine)}
            >
              Revoke
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More for ${label}`}
                >
                  <EllipsisIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                // Radix labels the menu by its trigger; Design names it instead.
                aria-labelledby={undefined}
                aria-label={`Actions for ${label}`}
              >
                <DropdownMenuItem onSelect={() => copy(id)}>
                  <CopyIcon />
                  Copy machine id
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}
