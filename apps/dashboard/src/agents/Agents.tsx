import { BrandMark, Button, Card, Skeleton } from "@ob/ui/shadcn";
import { type ReactNode, useId, useState } from "react";
import { qk } from "../api/qk";
import { useListedAgents } from "../api/queries";
import { CircleAlertIcon, RotateCwIcon } from "../layout/icons";
import { PageHeader } from "../layout/PageHeader";
import { useDocumentTitle } from "../layout/useDocumentTitle";
import { PausedNotice } from "../live/PausedNotice";
import { usePaused } from "../live/usePaused";
import { RosterBar } from "./RosterBar";
import { LoadingTable, RosterTable } from "./RosterTable";
import { type Filter, filtered, GLOBAL, liveCount, split } from "./roster";

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-foreground">{children}</span>
);

const LEGEND =
  "Live agents receive at once. Queued agents get messages if their machine reconnects within 1 hour; after that the sender is told it expired. Closed sessions leave the roster.";

/** "{N} agents in {ns} · {K} live", or "{shown} of {N} …" under a filter. */
function Summary(p: {
  what: ReactNode;
  agents: number;
  shown: number;
  live: number;
  filter: Filter;
  muted: boolean;
}) {
  return (
    <>
      {p.filter !== "all" && (
        <>
          <Mono>{p.shown}</Mono> of{" "}
        </>
      )}
      <Mono>{p.agents}</Mono> {p.what}{" "}
      {p.muted ? (
        // Paused: the live count is a past claim, muted like the badges (colour, no opacity).
        <span data-muted>
          · <span className="font-mono">{p.live}</span> live
        </span>
      ) : (
        <>
          · <Mono>{p.live}</Mono> live
        </>
      )}
    </>
  );
}

/**
 * The roster, one namespace at a time (Design D5): pick a namespace chip, or
 * the global chip for only the Global agents section. Global agents show once,
 * in their own section, under every namespace view. It shows exactly what the
 * server returns (live and queued agents). A dead stream only pauses updates:
 * the rows stay, muted, with the time they were last current.
 */
export function Agents() {
  useDocumentTitle("Agents");
  const {
    agents: all,
    error,
    isPending,
    isFetching,
    refetch,
  } = useListedAgents();
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const globalTitle = useId();

  const { byNs, global } = split(all ?? []);
  const namespaces = [...byNs.keys()].sort((a, b) => a.localeCompare(b));
  const exists = (v: string) =>
    v === GLOBAL ? global.length > 0 : byNs.has(v);
  // A picked view that left the roster resets to the first namespace, for good.
  if (picked !== null && all && !exists(picked)) setPicked(null);
  // No namespace but global agents: open on them, not on "No agents".
  const view =
    picked !== null && exists(picked)
      ? picked
      : (namespaces[0] ?? (global.length > 0 ? GLOBAL : null));
  const nsAgents =
    view !== null && view !== GLOBAL ? (byNs.get(view) ?? []) : [];

  const { paused, asOf } = usePaused();
  const loading = isPending && !error;

  const counted = (list: typeof nsAgents) => ({
    agents: list.length,
    shown: filtered(list, filter).length,
    live: liveCount(list),
    filter,
    muted: paused,
  });
  const n = (k: number, one: string, many: string) => (k === 1 ? one : many);

  const legend = <p className="text-xs text-muted-foreground">{LEGEND}</p>;
  const showGlobal = all !== undefined && view !== null && global.length > 0;

  return (
    <>
      <PageHeader title="Agents" />
      <div
        data-roster
        data-paused={String(paused)}
        className="group/roster flex min-w-0 flex-col gap-4"
      >
        <PausedNotice
          list="roster"
          queryKey={qk.agents}
          fetching={isFetching}
          refetch={refetch}
        />

        {all && (
          <RosterBar
            namespaces={namespaces.map((ns) => [ns, byNs.get(ns)?.length ?? 0])}
            globalCount={global.length}
            view={view}
            onView={setPicked}
            filter={filter}
            onFilter={setFilter}
          />
        )}
        {loading && (
          <div aria-hidden="true" className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-32 rounded-full" />
            <Skeleton className="h-7 w-20 rounded-full" />
          </div>
        )}

        <p className="text-sm text-muted-foreground" aria-live="polite">
          {all && view === null && "No agents"}
          {all && view === GLOBAL && (
            <Summary
              {...counted(global)}
              what={n(global.length, "global agent", "global agents")}
            />
          )}
          {all && view !== null && view !== GLOBAL && (
            <Summary
              {...counted(nsAgents)}
              what={
                <>
                  {n(nsAgents.length, "agent", "agents")} in{" "}
                  <bdi className="font-mono text-foreground">{view}</bdi>
                </>
              }
            />
          )}
          {loading && "Loading agents"}
        </p>

        {all && view !== null && view !== GLOBAL && (
          <RosterTable
            caption="Agents in this namespace"
            agents={filtered(nsAgents, filter)}
            asOf={asOf}
          />
        )}
        {loading && <LoadingTable />}

        {all && view === null && (
          <Card className="items-center gap-2 rounded-lg px-4 py-8 text-center shadow-none">
            <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
              <BrandMark className="size-5" />
            </div>
            <h2 className="mt-2 text-base font-semibold tracking-[-0.01em]">
              No agents in this namespace
            </h2>
            <p className="mb-2 max-w-[380px] text-sm text-muted-foreground">
              Agents appear here while a session on an approved machine is
              running.
            </p>
          </Card>
        )}

        {error && !all && (
          <Card
            role="alert"
            className="flex-row items-start gap-3 rounded-lg border-transparent bg-(--ob-danger-soft) px-4 py-3 shadow-none max-sm:flex-wrap"
          >
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-(--ob-danger)" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium">Couldn't load the roster</p>
              <p className="text-muted-foreground">
                The bus answered with an error.
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

        {showGlobal && (
          <section
            aria-labelledby={globalTitle}
            className="flex flex-col gap-3 pt-2"
          >
            <div>
              <h2
                id={globalTitle}
                className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]"
              >
                Global agents
              </h2>
              <p className="text-sm text-muted-foreground">
                Seen by every namespace. Any agent can message them.
              </p>
            </div>
            <RosterTable
              caption="Agents every namespace sees"
              agents={filtered(global, filter)}
              asOf={asOf}
            />
            {legend}
          </section>
        )}
        {!showGlobal && all && view !== null && legend}
      </div>
    </>
  );
}
