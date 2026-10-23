import { Card, CardContent, CardHeader, CardTitle } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";
import { AgentRow } from "./AgentRow";

/** One namespace's agents: a labeled region holding a list. */
export function NamespaceGroup({
  namespace,
  agents,
}: {
  namespace: string;
  agents: Agent[];
}) {
  return (
    <section aria-label={namespace}>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>
            <h2 className="truncate font-mono text-sm font-medium text-muted-foreground">
              {namespace}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <ul className="divide-y">
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
