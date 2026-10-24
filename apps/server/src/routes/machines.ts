import { isMachineId, MachinesResponseSchema, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { machineDtos } from "../hub/dto.js";
import { hub } from "../hub/stub.js";
import { noStore, requireOwner } from "./me.js";
import type { AppType } from "./types.js";

const MACHINE = "/api/v1/machines/:id";

/**
 * The dashboard's machines (B9). Both rows are `{session}`: DELETE passes
 * the gate's header CSRF (X-OB-Request: 1 plus same origin) first.
 */
export function mountMachines(app: AppType): void {
  app.use(R.machines, noStore());
  app.use(MACHINE, noStore());

  // Active first, then revoked, each newest first, capped (the hub's order).
  app.get(R.machines, async (c) => {
    requireOwner(c);
    const machines = machineDtos(await hub(c.env).listMachines());
    return c.json(MachinesResponseSchema.parse({ machines }));
  });

  // 204 on the first revoke; unknown, already-revoked and malformed are 404.
  app.delete(MACHINE, async (c) => {
    requireOwner(c);
    const id = c.req.param("id");
    if (!isMachineId(id) || !(await hub(c.env).revokeMachine(id)))
      throw new ApiError("not_found", "No such machine");
    return c.body(null, 204);
  });
}
