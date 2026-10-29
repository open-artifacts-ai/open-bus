import {
  Badge,
  Button,
  TableBody,
  TableCell,
  TableRow,
  toast,
} from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiClientError } from "../api/client";
import type { Agent, Role } from "../api/contract";
import { useListedAgents, useRemoveRole, useRoles } from "../api/queries";
import { isSignedIn } from "../api/queryClient";
import { messageOf } from "../format";
import { PageHeader } from "../layout/PageHeader";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { usePaused } from "../live/usePaused";
import { ClaimBadge } from "../ui/ClaimBadge";
import { EmptyCard } from "../ui/EmptyCard";
import { LoadError } from "../ui/LoadError";
import { Mono } from "../ui/Mono";
import { TableFrame } from "../ui/TableFrame";
import { roleKey } from "./focus";
import { RemoveRoleDialog } from "./RemoveRoleDialog";
import { RoleDialog, type RoleTarget } from "./RoleDialog";

const HEADS = [
  "Role",
  "Namespace",
  "Holder",
  <span key="actions" className="sr-only">
    Actions
  </span>,
];

/** The Machines row layout; below md it stacks into a two-column card. */
const ROW =
  "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-2 max-md:px-4 max-md:py-3";

const byNamespaceThenName = (a: Role, b: Role) =>
  a.namespace.localeCompare(b.namespace) || a.role.localeCompare(b.role);

/**
 * The owner's roles: each a name pointing at one agent id. The holder is
 * derived from the roster by id, never stored: missing (closed) reads
 * Vacant, so a holder closing flips its role on the next agents frame.
 */
export function Roles() {
  useDocumentTitle("Roles");
  const roles = useRoles();
  const listed = useListedAgents();
  const remove = useRemoveRole();
  const qc = useQueryClient();
  const { asOf } = usePaused();

  const [editing, setEditingState] = useState<RoleTarget | null>(null);
  // Bumped on each open: RoleDialog remounts and starts from its target.
  const [dialogKey, setDialogKey] = useState(0);
  const setEditing = (t: RoleTarget | null) => {
    if (t) setDialogKey((k) => k + 1);
    setEditingState(t);
  };
  const [removing, setRemoving] = useState<Role | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Listed, not raw: a holder on a machine with a revoke pending reads
  // Vacant at once, deliberately, as its agents leave the Agents page too.
  const agents = listed.agents;
  const list = useMemo(
    () => roles.data?.roles.slice().sort(byNamespaceThenName),
    [roles.data],
  );
  const byId = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );
  const holderOf = (r: Role) =>
    r.agentId === null ? undefined : byId.get(r.agentId);

  const confirmRemove = () => {
    const target = removing;
    setConfirmOpen(false);
    if (!target) return;
    remove.mutateAsync(target).then(
      () => {
        if (!isSignedIn(qc)) return;
        toast.success(
          <>
            <bdi className="font-mono">{target.role}</bdi> removed
          </>,
          { duration: 8000 },
        );
      },
      (e: unknown) => {
        if (!isSignedIn(qc)) return;
        if (e instanceof ApiClientError && e.code === "unauthorized") return;
        toast.error(
          <>
            Couldn't remove <bdi className="font-mono">{target.role}</bdi>
          </>,
          { description: messageOf(e), duration: 8000 },
        );
      },
    );
  };

  // Both lists, or a holder would read Vacant before the roster arrives.
  const ready = list !== undefined && agents !== undefined;
  const error = roles.error ?? listed.error;
  const vacant = ready ? list.filter((r) => !holderOf(r)).length : 0;

  return (
    <>
      <PageHeader title="Roles">
        <Button
          size="sm"
          className="ml-auto"
          disabled={!ready}
          onClick={() => setEditing({ mode: "add" })}
        >
          Add role
        </Button>
      </PageHeader>
      <div className="flex flex-col gap-4">
        <p data-summary className="text-sm text-muted-foreground">
          {ready && list.length > 0 && (
            <>
              <Mono>{list.length}</Mono> {list.length === 1 ? "role" : "roles"}{" "}
              · <Mono>{vacant}</Mono> vacant
            </>
          )}
          {!ready && !error && "Loading roles"}
        </p>

        {ready && list.length > 0 && (
          <TableFrame
            caption="Roles and the agents they point at"
            heads={HEADS}
          >
            <TableBody className="max-md:block">
              {list.map((r) => (
                <RoleRow
                  key={roleKey(r)}
                  role={r}
                  holder={holderOf(r)}
                  muted={asOf}
                  onRepoint={() => setEditing({ mode: "repoint", role: r })}
                  onRemove={() => {
                    setRemoving(r);
                    setConfirmOpen(true);
                  }}
                />
              ))}
            </TableBody>
          </TableFrame>
        )}

        {ready && list.length === 0 && (
          <EmptyCard
            title="No roles yet"
            help="A role is a name, such as lane-6, that you point at one agent."
          >
            <Button onClick={() => setEditing({ mode: "add" })}>
              Add role
            </Button>
          </EmptyCard>
        )}

        {error && !ready && (
          <LoadError
            title="Couldn't load roles"
            error={error}
            fetching={roles.isFetching || listed.isFetching}
            onRetry={() => {
              void roles.refetch();
              void listed.refetch();
            }}
          />
        )}
      </div>

      <RoleDialog
        key={dialogKey}
        target={editing}
        agents={agents ?? []}
        roles={list ?? []}
        onClose={() => setEditing(null)}
      />
      <RemoveRoleDialog
        open={confirmOpen}
        target={removing}
        onConfirm={confirmRemove}
        onClose={() => setConfirmOpen(false)}
      />
    </>
  );
}

function RoleRow({
  role: r,
  holder,
  muted,
  onRepoint,
  onRemove,
}: {
  role: Role;
  holder: Agent | undefined;
  muted: string | null;
  onRepoint(): void;
  onRemove(): void;
}) {
  return (
    <TableRow className={ROW}>
      <TableCell className="w-full min-w-0 whitespace-normal px-4 py-2 font-mono max-md:p-0">
        <span className="[overflow-wrap:anywhere]">
          <bdi data-role className="font-medium">
            {r.role}
          </bdi>
          {holder && (
            <>
              {" → "}
              <bdi>{holder.name}</bdi>
            </>
          )}
        </span>
      </TableCell>
      <TableCell className="min-w-0 whitespace-normal px-4 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere] max-md:col-span-2 max-md:row-start-2 max-md:p-0">
        {r.namespace}
      </TableCell>
      <TableCell className="px-4 max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
        {holder ? (
          <ClaimBadge
            status={holder.state}
            subject={`${holder.name} on ${holder.machineLabel}`}
            muted={muted}
          />
        ) : (
          <Badge variant="secondary" data-status="vacant">
            Vacant
          </Badge>
        )}
      </TableCell>
      <TableCell className="px-4 max-md:col-span-2 max-md:p-0">
        <div className="flex items-center justify-end gap-1 max-md:justify-start">
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-full px-3"
            data-role-key={roleKey(r)}
            aria-label={`Re-point ${r.role}`}
            onClick={onRepoint}
          >
            Re-point
          </Button>
          <Button
            variant="destructive"
            size="sm"
            aria-label={`Remove ${r.role}`}
            className="h-7 rounded-full border border-transparent bg-(--ob-danger-soft) px-3 text-(--ob-danger) hover:border-(--ob-danger) hover:bg-(--ob-danger-soft)"
            onClick={onRemove}
          >
            Remove
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
