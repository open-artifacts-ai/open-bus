import { LinkedAppsResponseSchema, R } from "@ob/shared";
import { parseOrigin } from "../card/origin.js";
import { ApiError } from "../http/errors.js";
import { iso } from "../hub/dto.js";
import { hub } from "../hub/stub.js";
import { noStore, requireOwner } from "./me.js";
import type { AppType } from "./types.js";

const LINKED_APP = "/api/v1/linked-apps/:aud";

/**
 * The owner's linked apps (AC4b). Both rows are `{session}`: DELETE passes
 * the gate's header CSRF first. `:aud` is the URL-encoded origin
 * (R.linkedApp); Hono decodes it.
 */
export function mountLinkedApps(app: AppType): void {
  app.use(R.linkedApps, noStore());
  app.use(LINKED_APP, noStore());

  app.get(R.linkedApps, async (c) => {
    requireOwner(c);
    const rows = await hub(c.env).listLinkedApps();
    const apps = rows.map((r) => ({ aud: r.aud, linkedAt: iso(r.linkedAt) }));
    return c.json(LinkedAppsResponseSchema.parse({ apps }));
  });

  // 204 on the first unlink; unknown or already unlinked is 404. Only an
  // exact canonical origin is accepted: a non-canonical spelling is 400,
  // never silently normalized onto another app's row.
  app.delete(LINKED_APP, async (c) => {
    requireOwner(c);
    const aud = c.req.param("aud");
    if (parseOrigin(aud, c.env) !== aud)
      throw new ApiError("bad_request", "aud is not an exact https origin", {
        field: "aud",
      });
    if (!(await hub(c.env).unlinkApp(aud)))
      throw new ApiError("not_found", "No such linked app");
    return c.body(null, 204);
  });
}
