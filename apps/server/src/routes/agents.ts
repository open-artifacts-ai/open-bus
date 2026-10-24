import { AgentListQuerySchema, AgentsResponseSchema, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { hub } from "../hub/stub.js";
import { requireOwner } from "./me.js";
import type { AppType } from "./types.js";

/** The first offending query parameter of a failed strict parse. */
function badField(
  issues: readonly { path: PropertyKey[]; keys?: string[] }[],
): string | undefined {
  const i = issues[0];
  const f = i?.keys?.[0] ?? i?.path[0];
  return typeof f === "string" ? f : undefined;
}

export function mountAgents(app: AppType): void {
  app.get(R.agents, async (c) => {
    requireOwner(c);
    const query: Record<string, string> = {};
    for (const [k, vs] of Object.entries(c.req.queries())) {
      if (vs.length !== 1)
        throw new ApiError("bad_request", "Repeated query parameter", {
          field: k,
        });
      query[k] = vs[0] as string;
    }
    const q = AgentListQuerySchema.safeParse(query);
    if (!q.success) {
      const field = badField(q.error.issues as never);
      throw new ApiError(
        "bad_request",
        "Invalid query",
        field ? { field } : undefined,
      );
    }
    // Absent stays undefined (all agents); never null or "" (the hub's []).
    const agents =
      q.data.namespace === undefined
        ? await hub(c.env).listAgents()
        : await hub(c.env).listAgents(q.data.namespace);
    return c.json(AgentsResponseSchema.parse({ agents }));
  });
}
