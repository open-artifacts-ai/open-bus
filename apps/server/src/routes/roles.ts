import {
  BusNameSchema,
  PutRoleBodySchema,
  R,
  RolesResponseSchema,
  WireNamespaceSchema,
} from "@ob/shared";
import type { Context } from "hono";
import { jsonBody } from "../http/body.js";
import { ApiError } from "../http/errors.js";
import { roleDtos } from "../hub/dto.js";
import type { SetRoleResult } from "../hub/roles.js";
import { hub } from "../hub/stub.js";
import { noStore, requireOwner } from "./me.js";
import type { AppType } from "./types.js";

const ROLE = "/api/v1/roles/:namespace/:role";

/** The path's namespace and role, validated as R.role does (400 with the field). */
function target(c: Context): { ns: string; role: string } {
  const ns = c.req.param("namespace") ?? "";
  const role = c.req.param("role") ?? "";
  if (!WireNamespaceSchema.safeParse(ns).success)
    throw new ApiError("bad_request", "Invalid namespace", {
      field: "namespace",
    });
  if (!BusNameSchema.safeParse(role).success)
    throw new ApiError("bad_request", "Invalid role", { field: "role" });
  return { ns, role };
}

const REFUSED: Record<Exclude<SetRoleResult, "ok">, () => ApiError> = {
  bad_agent: () =>
    new ApiError("bad_request", "No such agent in that namespace", {
      field: "agentId",
    }),
  name_taken: () => new ApiError("conflict", "An agent already has that name"),
  agent_has_role: () =>
    new ApiError("conflict", "That agent already has a role"),
  full: () => new ApiError("conflict", "Too many roles"),
};

/**
 * Owner-assigned roles (agent card, AC2b). All three rows are `{session}`:
 * PUT and DELETE pass the gate's header CSRF (X-OB-Request plus same origin)
 * first, and a machine token never reaches them.
 */
export function mountRoles(app: AppType): void {
  app.use(R.roles, noStore());
  app.use(ROLE, noStore());

  app.get(R.roles, async (c) => {
    requireOwner(c);
    const roles = roleDtos(await hub(c.env).listRoles());
    return c.json(RolesResponseSchema.parse({ roles }));
  });

  // 204, 400 (field namespace, role, body or agentId) or 409 conflict.
  app.put(ROLE, async (c) => {
    requireOwner(c);
    const { ns, role } = target(c);
    let agentId: string;
    try {
      ({ agentId } = await jsonBody(c.req.raw, PutRoleBodySchema));
    } catch (e) {
      if (e instanceof ApiError && e.code === "bad_request")
        throw new ApiError("bad_request", e.message, { field: "body" });
      throw e;
    }
    const r = await hub(c.env).putRole(ns, role, agentId);
    if (r !== "ok") throw REFUSED[r]();
    return c.body(null, 204);
  });

  // 204, then 404 not_found.
  app.delete(ROLE, async (c) => {
    requireOwner(c);
    const { ns, role } = target(c);
    if (!(await hub(c.env).deleteRole(ns, role)))
      throw new ApiError("not_found", "No such role");
    return c.body(null, 204);
  });
}
