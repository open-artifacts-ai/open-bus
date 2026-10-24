import { logError, logEvent } from "../util/log.js";
import { ApiError } from "./errors.js";

/** The caller's IP as Cloudflare saw it; one shared bucket when absent (local dev). */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/** rate_limit_unavailable is logged at most once per isolate. */
let warned = false;

/** Tests only: forget that the unavailable warning was logged. */
export function resetRateLimitWarning(): void {
  warned = false;
}

function unavailable(err: unknown): void {
  if (warned) return;
  warned = true;
  logError("rate_limit_unavailable", err ?? new Error("binding not bound"));
}

/**
 * Workers Rate Limiting seam (B11). `limiter` is a ratelimit binding such as
 * RL_AUTH. Never fails closed per request: when it is unbound (tests, dev, or
 * a deploy without it), throws, or its promise rejects, the request continues
 * and the hub's own cap (MAX_OIDC_STATES in hub/do.ts) is what bounds the
 * writes; rate_limit_unavailable is logged once per isolate. Only an explicit
 * over-the-limit answer from the binding throws ApiError `rate_limited`
 * (429), logged with its kind only.
 */
export async function enforceRateLimit(
  limiter: RateLimit | undefined,
  kind: string,
  ip: string,
): Promise<void> {
  if (!limiter) {
    unavailable(null);
    return;
  }
  let ok: boolean;
  try {
    ok = (await limiter.limit({ key: `${kind}:${ip}` })).success;
  } catch (e) {
    unavailable(e);
    return;
  }
  if (ok) return;
  logEvent("rate_limited", { kind });
  throw new ApiError("rate_limited", "Too many requests");
}
