import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useMemo, useState } from "react";
import { ApiClientError } from "../api/client";
import { type Agent, BusNameSchema, LIMITS, type Role } from "../api/contract";
import { useSetRole } from "../api/queries";
import { isSignedIn } from "../api/queryClient";
import { messageOf } from "../format";
import { focusRow } from "./focus";

type Field = "namespace" | "role" | "agentId";
type Errors = Partial<Record<Field | "form", string>>;

const FIELDS: readonly string[] = ["namespace", "role", "agentId"];

/**
 * The server's 409s carry no `details.field`; their messages (routes/roles.ts)
 * say which input is at fault. Anything else (full) is the form's.
 */
const CONFLICT_FIELD: Record<string, Field> = {
  "An agent already has that name": "role",
  "That agent already has a role": "agentId",
};

/** The field a 400/409 belongs on, if any. */
const fieldOf = (err: ApiClientError): Field | undefined => {
  if (err.field && FIELDS.includes(err.field)) return err.field as Field;
  if (err.status === 409) return CONFLICT_FIELD[err.message];
  return undefined;
};

/** Add a role, or re-point one (its namespace and name locked). */
export type RoleTarget = { mode: "add" } | { mode: "repoint"; role: Role };

const RANK: Record<Agent["state"], number> = { live: 0, queued: 1 };

/**
 * Namespaces a role can live in: those of open non-global agents (most
 * agents first, as on Agents) plus those that already hold roles.
 */
function namespacesOf(agents: Agent[], roles: Role[]) {
  const count = new Map<string, number>();
  for (const a of agents)
    if (!a.global) count.set(a.namespace, (count.get(a.namespace) ?? 0) + 1);
  for (const r of roles) count.set(r.namespace, count.get(r.namespace) ?? 0);
  return [...count]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([ns]) => ns);
}

/** Client-side check before any PUT; the server has the last word. */
const nameError = (name: string): string | undefined => {
  if (name === "") return "Enter a role name.";
  if ([...name].length > LIMITS.maxBusNameChars)
    return `At most ${LIMITS.maxBusNameChars} characters.`;
  const r = BusNameSchema.safeParse(name);
  if (r.success) return undefined;
  return r.error.issues.some((i) => i.message.includes("reserved"))
    ? "That name is reserved for system notices."
    : "Use letters, digits, spaces, dots, hyphens or underscores, starting with a letter or digit.";
};

/**
 * Add a role or re-point one. The holder picker offers open agents (live or
 * queued) in the namespace plus global agents; one that already holds
 * another role is listed disabled ("holds <role>"). Not optimistic: a 409 or
 * 400 lands on its field (by `details.field`, else a 409's message), anything
 * else in a form alert, and the dialog stays open with the input as typed.
 */
export function RoleDialog({
  target,
  agents,
  roles,
  onClose,
}: {
  /** null while closed. */
  target: RoleTarget | null;
  agents: Agent[];
  roles: Role[];
  onClose(): void;
}) {
  const qc = useQueryClient();
  const setRole = useSetRole();
  const id = useId();
  const namespaces = useMemo(
    () => namespacesOf(agents, roles),
    [agents, roles],
  );

  // The page remounts this per open (a fresh key), so the form starts from
  // `target` on its first frame. Kept after closing, so the content doesn't
  // vanish mid-animation.
  const [shown] = useState(target);
  const start = shown?.mode === "repoint" ? shown.role : null;
  const [namespace, setNamespace] = useState(
    () => start?.namespace ?? namespaces[0] ?? "",
  );
  const [name, setName] = useState(start?.role ?? "");
  const [agentId, setAgentId] = useState(() =>
    start?.agentId && agents.some((a) => a.id === start.agentId)
      ? start.agentId
      : "",
  );
  const [errors, setErrors] = useState<Errors>({});

  const lockedRole = shown?.mode === "repoint" ? shown.role : null;

  /** The role each agent holds, from the roles list and the roster. */
  const held = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents) if (a.role) m.set(a.id, a.role);
    for (const r of roles) if (r.agentId) m.set(r.agentId, r.role);
    return m;
  }, [agents, roles]);

  const options = useMemo(
    () =>
      agents
        .filter((a) => a.global || a.namespace === namespace)
        .sort(
          (x, y) =>
            RANK[x.state] - RANK[y.state] || x.name.localeCompare(y.name),
        ),
    [agents, namespace],
  );
  /** Held by a role other than the one being re-pointed. */
  const takenBy = (a: Agent) => {
    const r = held.get(a.id);
    if (!r) return undefined;
    if (lockedRole && lockedRole.agentId === a.id) return undefined;
    return r;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (setRole.isPending) return;
    const next: Errors = {};
    if (!namespace) next.namespace = "Pick a namespace.";
    const bad = lockedRole ? undefined : nameError(name);
    if (bad) next.role = bad;
    if (!agentId) next.agentId = "Pick an agent.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const holder = agents.find((a) => a.id === agentId);
    setRole.mutateAsync({ namespace, role: name, agentId }).then(
      () => {
        if (!isSignedIn(qc)) return;
        toast.success(
          <>
            <bdi className="font-mono">{name}</bdi> points at{" "}
            <bdi className="font-mono">{holder?.name ?? agentId}</bdi>
          </>,
          { duration: 8000 },
        );
        onClose();
      },
      (err: unknown) => {
        if (!isSignedIn(qc)) return;
        if (err instanceof ApiClientError) {
          if (err.code === "unauthorized") return;
          const f =
            err.status === 400 || err.status === 409 ? fieldOf(err) : undefined;
          if (f) return setErrors({ [f]: err.message });
        }
        setErrors({ form: messageOf(err) });
      },
    );
  };

  const errorId = (f: Field) => `${id}-${f}-error`;
  const invalid = (f: Field) =>
    errors[f]
      ? { "aria-invalid": true as const, "aria-describedby": errorId(f) }
      : {};
  const fieldError = (f: Field) =>
    errors[f] && (
      <p id={errorId(f)} className="text-sm text-destructive">
        {errors[f]}
      </p>
    );
  const title = lockedRole ? `Re-point ${lockedRole.role}` : "Add role";

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="border-0 shadow-(--ob-shadow-2)"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          focusRow(lockedRole);
        }}
      >
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">
            {title}
          </DialogTitle>
          <DialogDescription>
            A role points at one open agent. If that agent closes, the role
            reads Vacant until you re-point it.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor={`${id}-namespace`}>Namespace</Label>
            <Select
              value={namespace}
              disabled={lockedRole !== null}
              onValueChange={(ns) => {
                setNamespace(ns);
                const still = agents.find((a) => a.id === agentId);
                if (still && !(still.global || still.namespace === ns))
                  setAgentId("");
                setErrors(({ namespace: _, ...rest }) => rest);
              }}
            >
              <SelectTrigger
                id={`${id}-namespace`}
                className="w-full font-mono"
                {...invalid("namespace")}
              >
                <SelectValue placeholder="Pick a namespace" />
              </SelectTrigger>
              <SelectContent>
                {(lockedRole ? [lockedRole.namespace] : namespaces).map(
                  (ns) => (
                    <SelectItem key={ns} value={ns} className="font-mono">
                      {ns}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            {fieldError("namespace")}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${id}-role`}>Role name</Label>
            <Input
              id={`${id}-role`}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              placeholder="lane-6"
              value={name}
              readOnly={lockedRole !== null}
              onChange={(e) => {
                setName(e.target.value);
                setErrors(({ role: _, ...rest }) => rest);
              }}
              {...invalid("role")}
            />
            {fieldError("role")}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${id}-agentId`}>Holder</Label>
            <Select
              value={agentId}
              onValueChange={(v) => {
                setAgentId(v);
                setErrors(({ agentId: _, ...rest }) => rest);
              }}
            >
              <SelectTrigger
                id={`${id}-agentId`}
                className="w-full"
                {...invalid("agentId")}
              >
                <SelectValue placeholder="Pick an agent" />
              </SelectTrigger>
              <SelectContent>
                {options.map((a) => {
                  const taken = takenBy(a);
                  return (
                    <SelectItem key={a.id} value={a.id} disabled={!!taken}>
                      <bdi className="font-mono">{a.name}</bdi>
                      <span className="text-muted-foreground">
                        {" "}
                        on <bdi>{a.machineLabel}</bdi>
                        {a.global && " · global"}
                        {a.state === "queued" && " · queued"}
                        {taken && ` · holds ${taken}`}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {options.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No open agents in this namespace.
              </p>
            )}
            {fieldError("agentId")}
          </div>

          {errors.form && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Couldn't save the role. {errors.form}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={setRole.isPending}
              aria-label={setRole.isPending ? undefined : "Save role"}
            >
              {setRole.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
