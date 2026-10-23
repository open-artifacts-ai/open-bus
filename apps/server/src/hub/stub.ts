import { OWNER_ORG_ID } from "@ob/shared";
import type { Env } from "../env.js";
import type { HubStub } from "./do.js";

/** One hub per owner. A future D1 directory replaces this constant lookup. */
export function hub(env: Pick<Env, "HUB">): HubStub {
  const ns = env.HUB;
  return ns.get(ns.idFromName(OWNER_ORG_ID)) as unknown as HubStub;
}
