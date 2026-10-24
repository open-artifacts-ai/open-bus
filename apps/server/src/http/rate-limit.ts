import { logError, logEvent } from "../util/log.js";
import { ApiError } from "./errors.js";

/** The caller's IP as Cloudflare saw it; one shared bucket when absent (local dev). */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

const UNKNOWN = "unknown";
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/** Dotted IPv4 with each octet 0..255, canonical (no leading zeros); else null. */
function ipv4(s: string): string | null {
  const m = IPV4.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts.join(".") : null;
}

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted tail folded in); else null. */
function ipv6Groups(s: string): number[] | null {
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = (h: string): number[] | null => {
    if (h === "") return [];
    const out: number[] = [];
    const parts = h.split(":");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] as string;
      if (i === parts.length - 1 && p.includes(".")) {
        const v4 = ipv4(p);
        if (v4 === null) return null;
        const [a, b, c, d] = v4.split(".").map(Number) as [
          number,
          number,
          number,
          number,
        ];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (HEX_GROUP.test(p)) out.push(Number.parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const head = side(halves[0] as string);
  const tail = halves.length === 2 ? side(halves[1] as string) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * The rate-limit and per-IP share key for a client address (adv-B4 R1):
 * IPv4 as is (canonical dotted form); IPv6 by its /64 (one host or site
 * holds a whole /64, so per-address keys would give it 2^64 buckets), as
 * `a:b:c:d::/64` with `::` expanded and leading zeros dropped; an
 * IPv4-mapped address (`::ffff:a.b.c.d`) as its IPv4. A missing or malformed
 * value (blank, a zone id, brackets, a port) is the one shared key
 * `"unknown"`, never a bucket of its own. Used for RL_DEVICE, RL_AUTH and
 * the device-code ip_tag.
 */
export function clientKey(ip: string | null | undefined): string {
  if (typeof ip !== "string") return UNKNOWN;
  const s = ip.trim().toLowerCase();
  if (s.length === 0 || s.length > 64) return UNKNOWN;
  const v4 = ipv4(s);
  if (v4 !== null) return v4;
  if (!s.includes(":")) return UNKNOWN;
  const g = ipv6Groups(s);
  if (g === null) return UNKNOWN;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const [hi, lo] = [g[6] as number, g[7] as number];
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
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
