import { BrandMark, Card } from "@ob/ui/shadcn";
import type { ReactNode } from "react";

/** Design's empty state: the brand mark, a heading, a line of help, then any actions. */
export function EmptyCard({
  title,
  help,
  children,
}: {
  title: string;
  help: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className="items-center gap-2 rounded-lg px-4 py-8 text-center shadow-none">
      <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
        <BrandMark className="size-5" />
      </div>
      <h2 className="mt-2 text-base font-semibold tracking-[-0.01em]">
        {title}
      </h2>
      <p className="mb-2 max-w-[380px] text-sm text-muted-foreground">{help}</p>
      {children}
    </Card>
  );
}
