import { Button } from "@ob/ui/shadcn";
import { Link } from "@tanstack/react-router";
import { useDocumentTitle } from "../layout/useDocumentTitle";

/** Rendered inside the shell (the root route's notFoundComponent and `*`). */
export function NotFound() {
  useDocumentTitle("Not found");
  return (
    <section className="max-w-[400px] pt-16">
      <h1 className="text-(length:--ob-text-xl) font-semibold">Not found</h1>
      <p className="mt-2 text-muted-foreground">
        That page isn't part of the bus.
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/">Back to machines</Link>
      </Button>
    </section>
  );
}
