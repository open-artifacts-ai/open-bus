import { Card, CardContent, CardHeader, CardTitle } from "@ob/ui/shadcn";
import type { Agent } from "../api/contract";
import { AgentRow } from "./AgentRow";
import { GLOBAL_GROUP } from "./roster";

/** One group of agents (a namespace, or Global agents): a labeled region holding a list. */
export function NamespaceGroup({
  name,
  agents,
  asOf,
}: {
  name: string;
  agents: Agent[];
  asOf: string | null;
}) {
  return (
    <section aria-label={name}>
      <Card className="gap-2 py-4">
        <CardHeader className="px-4">
          <CardTitle>
            <h2
              className={
                name === GLOBAL_GROUP
                  ? "truncate text-sm font-medium text-muted-foreground"
                  : "truncate font-mono text-sm font-medium text-muted-foreground"
              }
            >
              {name}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          <ul className="divide-y">
            {agents.map((a) => (
              <AgentRow key={a.id} agent={a} asOf={asOf} />
            ))}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
