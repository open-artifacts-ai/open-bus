import {
  Card,
  Table,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from "@ob/ui/shadcn";
import type { ReactNode } from "react";

/** Design D4/D5's table head: uppercase, muted, on secondary; hidden (not gone) below md. */
const HEAD = "h-8 px-4 text-xs tracking-wide text-muted-foreground uppercase";

/** The card-framed table both pages use: an sr-only caption, then one head cell per column. */
export function TableFrame({
  caption,
  heads,
  busy,
  children,
}: {
  caption: string;
  heads: ReactNode[];
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 overflow-hidden rounded-lg py-0 shadow-none">
      <Table aria-busy={busy || undefined} className="max-md:block">
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader className="bg-secondary max-md:sr-only">
          <TableRow>
            {heads.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of columns
              <TableHead key={i} className={HEAD}>
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        {children}
      </Table>
    </Card>
  );
}
