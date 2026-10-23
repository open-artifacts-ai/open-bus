import { Separator, ToggleGroup, ToggleGroupItem } from "@ob/ui/shadcn";
import { GlobeIcon } from "../layout/icons";
import { type Filter, GLOBAL } from "./roster";

/** Design D5's pill: ToggleGroupItem size sm, rounded, secondary when on. */
const PILL =
  "gap-1.5 rounded-full px-2.5 text-xs font-normal data-[state=on]:shadow-[inset_0_0_0_1px_var(--ob-border-strong)]";
const ON = "data-[state=on]:bg-secondary data-[state=on]:text-foreground";
/** Namespace chips grow (h-auto) so long names wrap instead of overflowing. */
const WRAP = "h-auto min-h-7 max-w-full py-1 text-left whitespace-normal";
/** The global chip is always accent; hover only adds the accent ring. */
const ACCENT =
  "bg-(--ob-accent-soft) text-(--ob-accent-fg) hover:bg-(--ob-accent-soft) hover:text-(--ob-accent-fg) hover:shadow-[inset_0_0_0_1px_var(--ob-accent-fg)] data-[state=on]:bg-(--ob-accent-soft) data-[state=on]:text-(--ob-accent-fg)";

const Count = ({ n, className }: { n: number; className?: string }) => (
  <span className={`font-mono tabular-nums ${className ?? ""}`.trim()}>
    <span className="sr-only">, </span>
    {n}
    <span className="sr-only">{n === 1 ? " agent" : " agents"}</span>
  </span>
);

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["live", "Live"],
  ["queued", "Queued"],
];

/**
 * The namespace chips (one per namespace with its agent count, then the
 * accent global chip) and the All · Live · Queued filter. Both wrap; nothing
 * scrolls sideways. Radix sends "" when the pressed item is clicked again:
 * the choice stays.
 */
export function RosterBar({
  namespaces,
  globalCount,
  view,
  onView,
  filter,
  onFilter,
}: {
  namespaces: [string, number][];
  globalCount: number;
  view: string | null;
  onView(next: string): void;
  filter: Filter;
  onFilter(next: Filter): void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      {namespaces.length + globalCount > 0 ? (
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Namespaces"
          value={view ?? ""}
          onValueChange={(v) => {
            if (v) onView(v);
          }}
          className="max-w-full min-w-0 flex-wrap gap-y-2"
        >
          {namespaces.map(([ns, n]) => (
            <ToggleGroupItem
              key={ns}
              value={ns}
              title={ns}
              className={`${PILL} ${ON} ${WRAP}`}
            >
              <bdi className="font-mono [overflow-wrap:anywhere]">{ns}</bdi>
              <Count n={n} className="text-muted-foreground" />
            </ToggleGroupItem>
          ))}
          {globalCount > 0 && namespaces.length > 0 && (
            <Separator
              orientation="vertical"
              className="mx-1 data-[orientation=vertical]:h-5"
            />
          )}
          {globalCount > 0 && (
            <ToggleGroupItem
              value={GLOBAL}
              className={`${PILL} ${WRAP} ${ACCENT}`}
            >
              <GlobeIcon className="size-3.5" />
              <span className="font-mono">global</span>
              <Count n={globalCount} />
            </ToggleGroupItem>
          )}
        </ToggleGroup>
      ) : (
        <span />
      )}
      <ToggleGroup
        type="single"
        size="sm"
        spacing={1}
        aria-label="Filter"
        value={filter}
        onValueChange={(v) => {
          if (v) onFilter(v as Filter);
        }}
        className="flex-wrap"
      >
        {FILTERS.map(([value, word]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className={`h-7 ${PILL} ${ON}`}
          >
            {word}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
