import { OWNER_ORG_ID } from "@ob/shared";
import type { Env } from "../env.js";
import type { HubStub } from "./do.js";

/** One hub per owner. A future D1 directory replaces this constant lookup. */
export function hub(env: Pick<Env, "HUB">): HubStub {
  const ns = env.HUB;
  return ns.get(ns.idFromName(OWNER_ORG_ID)) as unknown as HubStub;
}

/**
 * A request to the owner hub's own fetch handler (the /hub upgrade). Callers
 * build `init` from scratch: never pass a client's headers through.
 */
export function hubFetch(
  env: Pick<Env, "HUB">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const ns = env.HUB;
  return ns
    .get(ns.idFromName(OWNER_ORG_ID))
    .fetch(new Request(`https://hub.internal${path}`, init));
}
