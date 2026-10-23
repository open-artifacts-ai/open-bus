import { isMachineToken, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { sha256Hex } from "../hub/hash.js";
import { hub, hubFetch } from "../hub/stub.js";
import type { AppType } from "./types.js";

const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * The daemon socket. The Worker never speaks the protocol: it proves the
 * machine token, then forwards a fresh upgrade request to the hub carrying
 * only `Upgrade` and the verified `X-Ob-Machine-Id`. Client headers are never
 * forwarded, so a client-supplied X-Ob-Machine-Id cannot reach the hub.
 */
export function mountHub(app: AppType): void {
  app.get(R.hub, async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
      throw new ApiError("bad_request", "Expected a WebSocket upgrade");
    const token = BEARER.exec(c.req.header("authorization")?.trim() ?? "")?.[1];
    if (!isMachineToken(token))
      throw new ApiError("unauthorized", "Invalid machine token");
    const machine = await hub(c.env).verifyToken(await sha256Hex(token));
    if (!machine) throw new ApiError("unauthorized", "Invalid machine token");
    return hubFetch(c.env, "/hub", {
      headers: { Upgrade: "websocket", "X-Ob-Machine-Id": machine.id },
    });
  });
}
