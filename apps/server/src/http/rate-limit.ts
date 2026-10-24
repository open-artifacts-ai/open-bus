import { logError, logEvent } from "../util/log.js";
import { ApiError } from "./errors.js";

/** The caller's IP as Cloudflare saw it; one shared bucket when absent (local dev). */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/**
 * Workers Rate Limiting seam (B11). `limiter` is a ratelimit binding such as
 * RL_AUTH; unbound (tests, dev) the request continues. A limiter that throws
 * fails open (logged): the limit is abuse damping, never an outage. Over the
 * limit throws ApiError `rate_limited` (429), logged with its kind only.
 */
export async function enforceRateLimit(
  limiter: RateLimit | undefined,
  kind: string,
  ip: string,
): Promise<void> {
  if (!limiter) return;
  let ok: boolean;
  try {
    ok = (await limiter.limit({ key: `${kind}:${ip}` })).success;
  } catch (e) {
    logError("rate_limit_unavailable", e);
    return;
  }
  if (ok) return;
  logEvent("rate_limited", { kind });
  throw new ApiError("rate_limited", "Too many requests");
}
