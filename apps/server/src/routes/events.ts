import { R } from "@ob/shared";
import { ApiError, appOrigin, errorJson } from "../http/errors.js";
import { hubFetch } from "../hub/stub.js";
import { requireOwner } from "./me.js";
import type { AppType } from "./types.js";

/** The session expiry (epoch ms) the hub uses to close the socket in time. */
export const SESSION_EXP_HEADER = "x-ob-session-exp";

/**
 * The dashboard's live feed: a WebSocket served by the hub DO (hibernatable).
 * The Worker only gates it (session with a future expiry, an Origin equal to
 * the configured app origin against cross-site WebSocket hijacking, a real
 * upgrade) and sends the hub a fresh request: `Upgrade` and the session
 * expiry, never the client's headers. Only the DO's 101 comes back as is.
 */
export function mountEvents(app: AppType): void {
  app.get(R.events, async (c) => {
    const req = c.req.raw;
    // Hono answers HEAD with the GET handler; a HEAD never reaches the hub.
    if (req.method !== "GET")
      return errorJson(405, "bad_request", "Method not allowed", undefined, {
        Allow: "GET",
      });
    const s = requireOwner(c);
    if (s.exp === null || s.exp <= Date.now())
      throw new ApiError("unauthorized", "Sign in to continue");
    // The configured origin, never the request's own host (workers.dev and
    // preview hosts would otherwise trust themselves).
    if (req.headers.get("origin") !== appOrigin(c.env))
      throw new ApiError("csrf", "Cross-site request");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return errorJson(
        426,
        "bad_request",
        "Expected a WebSocket upgrade",
        undefined,
        { Upgrade: "websocket" },
      );
    const res = await hubFetch(c.env, "/events", {
      headers: { Upgrade: "websocket", [SESSION_EXP_HEADER]: String(s.exp) },
    });
    if (res.status === 101 && res.webSocket) return res;
    await res.body?.cancel().catch(() => {});
    return errorJson(502, "internal", "Hub unavailable");
  });
}
