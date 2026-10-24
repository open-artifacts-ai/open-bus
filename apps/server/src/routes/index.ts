import { mountAgents } from "./agents.js";
import { mountApprove } from "./approve.js";
import { mountAuth } from "./auth.js";
import { mountDevice } from "./device.js";
import { mountEvents } from "./events.js";
import { mountHub } from "./hub.js";
import { mountMe } from "./me.js";
import type { AppType } from "./types.js";

/** Feature routes mount here as later tasks land; each adds its ROUTE_POLICY rows. */
export function mountRoutes(app: AppType): void {
  mountAuth(app);
  mountHub(app);
  mountDevice(app);
  mountApprove(app);
  mountMe(app);
  mountAgents(app);
  mountEvents(app);
}
