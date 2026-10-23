import { Button, Skeleton } from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { qk } from "../api/qk";
import { useAgents } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import {
  useLivePausedAt,
  useLiveRetry,
  useLiveStatus,
} from "../live/LiveStatus";
import { LiveUpdates } from "./LiveUpdates";
import { NamespaceFilter } from "./NamespaceFilter";
import { NamespaceGroup } from "./NamespaceGroup";
import { clock, groupsFor, namespacesOf } from "./roster";

const messageOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong.";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The live roster, grouped by namespace, global agents in their own group.
 * It shows exactly what the server returns (live agents); the filter only
 * narrows the namespace groups. A dead stream only pauses updates: the rows
 * stay, muted, with the time they were last current.
 */
export function Agents() {
  useDocumentTitle("Agents");
  const qc = useQueryClient();
  const { data, error, isPending, isFetching, refetch } = useAgents();
  const status = useLiveStatus();
  const pausedAt = useLivePausedAt();
  const reconnect = useLiveRetry();
  const [picked, setPicked] = useState<string | null>(null);

  const all = data?.agents;
  const namespaces = namespacesOf(all ?? []);
  // A picked namespace that left the roster resets to All, for good.
  if (picked !== null && all && !namespaces.includes(picked)) setPicked(null);
  const ns = picked !== null && namespaces.includes(picked) ? picked : null;
  const groups = groupsFor(all ?? [], ns);
  const asOf = status === "paused" ? clock(pausedAt ?? new Date()) : null;

  // A parked stream reconnects and its hello refetches; otherwise refetch
  // here, once: a click while a fetch is in flight does nothing.
  const retry = () => {
    if (qc.isFetching({ queryKey: qk.agents }) > 0) return;
    if (!reconnect()) void refetch();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-(length:--ob-text-xl) font-semibold">Agents</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Agents connected to this bus, by namespace.
        {all && all.length > 0 && (
          <>
            {" "}
            {plural(all.length, "agent", "agents")} in{" "}
            {plural(namespaces.length, "namespace", "namespaces")}.
          </>
        )}
      </p>
      <div className="mt-2">
        <LiveUpdates asOf={asOf} retrying={isFetching} onRetry={retry} />
      </div>

      {isPending && !error && (
        <section
          aria-label="Loading agents"
          aria-busy="true"
          className="mt-6 grid gap-3"
        >
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-20 w-full" />
        </section>
      )}

      {error && !all && (
        <div
          role="alert"
          className="mt-6 rounded-lg border bg-card p-4 text-card-foreground"
        >
          <p className="text-sm font-medium">Couldn't load your agents.</p>
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

      {all && all.length === 0 && (
        <div className="mt-6 rounded-lg border border-dashed p-6">
          <p className="font-medium">No agents connected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect this machine, then start a Claude Code, OpenCode or Pi
            session in a repo. Agents appear here as they come up.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-muted p-3 text-sm">
            <code className="font-mono">npx open-bus</code>
          </pre>
        </div>
      )}

      {namespaces.length > 1 && (
        <div className="mt-4">
          <NamespaceFilter
            namespaces={namespaces}
            value={ns}
            onChange={setPicked}
          />
        </div>
      )}

      {groups.length > 0 && (
        <div className="mt-4 grid gap-4">
          {groups.map(([name, list]) => (
            <NamespaceGroup key={name} name={name} agents={list} asOf={asOf} />
          ))}
        </div>
      )}
    </>
  );
}
