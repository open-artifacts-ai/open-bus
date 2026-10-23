import {
  Card,
  Skeleton,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ob/ui/shadcn";
import type { ReactNode } from "react";
import type { Agent } from "../api/contract";
import { AgentRow } from "./AgentRow";

/** Design D5's table head: uppercase, muted, on secondary; hidden (not gone) below md. */
const HEAD = "h-8 px-4 text-xs tracking-wide text-muted-foreground uppercase";

function Frame({
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
            <TableHead className={HEAD}>Agent</TableHead>
            <TableHead className={HEAD}>Kind</TableHead>
            <TableHead className={HEAD}>Machine</TableHead>
            <TableHead className={HEAD}>Reachable</TableHead>
            <TableHead className={HEAD}>Updated</TableHead>
          </TableRow>
        </TableHeader>
        {children}
      </Table>
    </Card>
  );
}

/** One roster table; when the filter hides every row it says so in place. */
export function RosterTable({
  caption,
  agents,
  asOf,
}: {
  caption: string;
  agents: Agent[];
  asOf: string | null;
}) {
  return (
    <Frame caption={caption}>
      <TableBody className="max-md:block">
        {agents.map((a) => (
          <AgentRow key={a.id} agent={a} asOf={asOf} />
        ))}
        {agents.length === 0 && (
          <TableRow className="max-md:block">
            <TableCell
              colSpan={5}
              className="px-4 py-6 text-center text-muted-foreground max-md:block"
            >
              No agents match this filter.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Frame>
  );
}

const NAME_WIDTHS = ["w-32", "w-40", "w-36", "w-28", "w-24"] as const;

/** Five skeleton rows at the 48 px row height, no spinner. */
export function LoadingTable() {
  return (
    <Frame caption="Loading agents" busy>
      <TableBody aria-hidden="true" className="max-md:block">
        {NAME_WIDTHS.map((w) => (
          <TableRow
            key={w}
            className="h-12 max-md:grid max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-2 max-md:px-4 max-md:py-3"
          >
            <TableCell className="w-full px-4 max-md:p-0">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-1.5 rounded-full" />
                <Skeleton className={`h-3.5 ${w}`} />
              </div>
            </TableCell>
            <TableCell className="px-4 max-md:col-start-1 max-md:row-start-2 max-md:p-0">
              <Skeleton className="h-3.5 w-20" />
            </TableCell>
            <TableCell className="px-4 max-md:col-span-2 max-md:row-start-3 max-md:p-0">
              <Skeleton className="h-3.5 w-28" />
            </TableCell>
            <TableCell className="px-4 max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end max-md:p-0">
              <Skeleton className="h-5 w-16 rounded-full" />
            </TableCell>
            <TableCell className="px-4 max-md:col-start-2 max-md:row-start-2 max-md:justify-self-end max-md:p-0">
              <Skeleton className="h-3.5 w-14" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Frame>
  );
}
