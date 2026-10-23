import { Button, Skeleton } from "@ob/ui/shadcn";
import { useState } from "react";
import { useAgents } from "../api/queries";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { useLiveRetry } from "../live/LiveStatus";
import { LiveUpdates } from "./LiveUpdates";
import { NamespaceFilter } from "./NamespaceFilter";
import { NamespaceGroup } from "./NamespaceGroup";
import { groupByNamespace, inView, namespacesOf } from "./roster";

const messageOf = (e: unknown) =>
  e instanceof Error && e.message ? e.message : "Something went wrong.";

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The live roster, grouped by namespace. It shows exactly what the server
 * returns (live agents); the filter only narrows the groups, and global
 * agents stay in every view. A dead stream only pauses updates.
 */
export function Agents() {
  useDocumentTitle("Agents");
  const { data, error, isPending, isFetching, refetch } = useAgents();
  const reconnect = useLiveRetry();
  const [picked, setPicked] = useState<string | null>(null);

  const all = data?.agents;
  const namespaces = namespacesOf(all ?? []);
  // A namespace that left the roster can't be a view: fall back to all.
  const ns = picked !== null && namespaces.includes(picked) ? picked : null;
  const groups = groupByNamespace(inView(all ?? [], ns));

  const retry = () => {
    reconnect();
    void refetch();
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-(length:--ob-text-xl) font-semibold">Agents</h1>
        <LiveUpdates onRetry={retry} />
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
          {groups.map(([namespace, list]) => (
            <NamespaceGroup
              key={namespace}
              namespace={namespace}
              agents={list}
            />
          ))}
        </div>
      )}
    </>
  );
}
