import {
  EVENTS_DO_PATH,
  R,
  SESSION_EXP_HEADER,
  SESSION_GEN_HEADER,
} from "@ob/shared";
import { MAX_AGE_S } from "../auth/max-age.js";
import { ApiError, appOrigin, errorJson } from "../http/errors.js";
import { hubFetch } from "../hub/stub.js";
import { requireOwner } from "./me.js";
import type { AppType } from "./types.js";

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
    const s = requireOwner(c);
    // The hub's own bound on exp (now + MAX_AGE_S + 1 min of skew), checked
    // here too so a bad session is a 401, not a hub 400 mapped to 500.
    const now = Date.now();
    if (
      s.exp === null ||
      s.exp <= now ||
      s.exp > now + MAX_AGE_S * 1000 + 60_000 ||
      s.gen === null
    )
      throw new ApiError("unauthorized", "Sign in to continue");
    // The configured origin, never the request's own host (workers.dev and
    // preview hosts would otherwise trust themselves).
    if (req.headers.get("origin") !== appOrigin(c.env))
      throw new ApiError("csrf", "Cross-site request");
    // The contract pins 426 and no ErrorCode maps to it: code bad_request.
    // HEAD (Hono runs this GET handler for it) is never an upgrade: 426 too.
    if (
      req.method !== "GET" ||
      req.headers.get("upgrade")?.toLowerCase() !== "websocket"
    )
      return errorJson(
        426,
        "bad_request",
        "Expected a WebSocket upgrade",
        undefined,
        { Upgrade: "websocket" },
      );
    const res = await hubFetch(c.env, EVENTS_DO_PATH, {
      // Ours only: a fresh request never carries the client's values.
      headers: {
        Upgrade: "websocket",
        [SESSION_EXP_HEADER]: String(s.exp),
        [SESSION_GEN_HEADER]: String(s.gen),
      },
    });
    if (res.status === 101 && res.webSocket) return res;
    await res.body?.cancel().catch(() => {});
    return errorJson(500, "internal", "Hub unavailable");
  });
}
