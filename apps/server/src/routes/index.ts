import { mountHub } from "./hub.js";
import type { AppType } from "./types.js";

/** Feature routes mount here as later tasks land; each adds its ROUTE_POLICY rows. */
export function mountRoutes(app: AppType): void {
  mountHub(app);
}
