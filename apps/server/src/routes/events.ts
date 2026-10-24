import { R } from "@ob/shared";
import { ApiError, errorJson } from "../http/errors.js";
import { hub } from "../hub/stub.js";
import { requireOwner } from "./me.js";
import type { AppType } from "./types.js";

/** The session expiry (epoch ms) the hub uses to close the socket in time. */
export const SESSION_EXP_HEADER = "x-ob-session-exp";

/**
 * The dashboard's live feed: a WebSocket served by the hub DO (hibernatable).
 * The Worker only gates it (session, same-origin Origin against cross-site
 * WebSocket hijacking, a real upgrade) and forwards the request to the hub's
 * /events with the session expiry; the DO's 101 comes back unchanged.
 */
export function mountEvents(app: AppType): void {
  app.get(R.events, (c) => {
    const s = requireOwner(c);
    if (s.exp === null)
      throw new ApiError("unauthorized", "Sign in to continue");
    const req = c.req.raw;
    if (req.headers.get("origin") !== new URL(req.url).origin)
      throw new ApiError("csrf", "Cross-site request");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return errorJson(
        426,
        "bad_request",
        "Expected a WebSocket upgrade",
        undefined,
        { Upgrade: "websocket" },
      );
    const fwd = new Request(new URL("/events", req.url), req);
    // set() replaces any client-sent value: the client never chooses it.
    fwd.headers.set(SESSION_EXP_HEADER, String(s.exp));
    return (hub(c.env) as unknown as DurableObjectStub).fetch(fwd);
  });
}
