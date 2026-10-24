import { isMachineToken, R } from "@ob/shared";
import { ApiError } from "../http/errors.js";
import { refuse } from "../http/middleware.js";
import { clientIp, clientKey, enforceRateLimit } from "../http/rate-limit.js";
import { sha256Hex } from "../hub/hash.js";
import { hub, hubFetch } from "../hub/stub.js";
import type { AppType } from "./types.js";

const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * A hub refusal of the forwarded upgrade (non-101) as the standard error
 * envelope, never cached (W4): the cooldown 429 keeps its Retry-After and
 * carries it as retryAfterSec; a 401 (revoked between the Worker's check and
 * the hub's) is `unauthorized`; anything else is `internal`.
 */
async function hubRefusal(res: Response): Promise<Response> {
  await res.body?.cancel();
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    const sec = retry === null ? Number.NaN : Number(retry);
    const ok = Number.isSafeInteger(sec) && sec >= 0;
    const out = refuse(
      new ApiError(
        "rate_limited",
        "Too many requests",
        ok ? { retryAfterSec: sec } : undefined,
      ),
    );
    if (ok) out.headers.set("retry-after", String(sec));
    return out;
  }
  if (res.status === 401)
    return refuse(new ApiError("unauthorized", "Invalid machine token"));
  return refuse(new ApiError("internal", "Internal error"));
}

/**
 * The daemon socket. The Worker never speaks the protocol: it proves the
 * machine token, then forwards a fresh upgrade request to the hub carrying
 * only `Upgrade` and the verified `X-Ob-Machine-Id`. Client headers are never
 * forwarded, so a client-supplied X-Ob-Machine-Id cannot reach the hub.
 */
export function mountHub(app: AppType): void {
  app.get(R.hub, async (c) => {
    try {
      if (c.req.header("upgrade")?.toLowerCase() !== "websocket")
        throw new ApiError("bad_request", "Expected a WebSocket upgrade");
      // W1: anonymous callers reach the owner hub (verifyToken) only within a
      // per-client limit, keyed hub:<clientKey> on RL_AUTH (separate from
      // login's auth:<clientKey>), RL_AUTH's 20 a minute. A daemon reconnects
      // rarely, and the hub's 4429 cooldown bounds reconnect storms. Fails
      // open like every other limiter (enforceRateLimit).
      await enforceRateLimit(
        c.env.RL_AUTH,
        "hub",
        clientKey(clientIp(c.req.raw)),
      );
      const token = BEARER.exec(
        c.req.header("authorization")?.trim() ?? "",
      )?.[1];
      if (!isMachineToken(token))
        throw new ApiError("unauthorized", "Invalid machine token");
      const machine = await hub(c.env).verifyToken(await sha256Hex(token));
      if (!machine) throw new ApiError("unauthorized", "Invalid machine token");
      const res = await hubFetch(c.env, "/hub", {
        headers: { Upgrade: "websocket", "X-Ob-Machine-Id": machine.id },
      });
      return res.status === 101 ? res : hubRefusal(res);
    } catch (e) {
      if (e instanceof ApiError) return refuse(e);
      throw e;
    }
  });
}
