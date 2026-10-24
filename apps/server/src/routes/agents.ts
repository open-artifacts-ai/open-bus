import { AgentListQuerySchema, AgentsResponseSchema, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { hub } from "../hub/stub.js";
import { noStore, requireOwner } from "./me.js";
import type { AppType } from "./types.js";

export function mountAgents(app: AppType): void {
  app.use(R.agents, noStore());
  app.get(R.agents, async (c) => {
    requireOwner(c);
    const query: Record<string, string> = {};
    for (const [k, vs] of Object.entries(c.req.queries())) {
      // Unknown keys are never echoed back (unbounded, client-chosen text).
      if (k !== "namespace")
        throw new ApiError("bad_request", "Unknown query parameter", {
          field: "query",
        });
      if (vs.length !== 1)
        throw new ApiError("bad_request", "Repeated query parameter", {
          field: k,
        });
      query[k] = vs[0] as string;
    }
    // Only `namespace` is left: any failure is that field's.
    const q = AgentListQuerySchema.safeParse(query);
    if (!q.success)
      throw new ApiError("bad_request", "Invalid namespace", {
        field: "namespace",
      });
    // Absent stays undefined (all agents); never null or "" (the hub's []).
    const agents =
      q.data.namespace === undefined
        ? await hub(c.env).listAgents()
        : await hub(c.env).listAgents(q.data.namespace);
    return c.json(AgentsResponseSchema.parse({ agents }));
  });
}
