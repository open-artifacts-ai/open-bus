import { OriginSchema } from "@ob/shared";
import type { Env } from "../env.js";

/** `scheme://host[:port]` and nothing else (checked on the lowercased input). */
const SHAPE =
  /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([1-9][0-9]{0,4}))?$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A linked app's `aud` (AC4b) and `/link`'s `aud` (Task 9): an exact https
 * origin, returned lowercased with the default port dropped, else null. No
 * path (not even "/"), query, fragment or userinfo; no trailing dot or empty
 * label; no host the URL parser would rewrite (IDN, numeric IPv4 forms).
 * http only for a loopback host under ENVIRONMENT=dev. Always at least as
 * strict as the shared OriginSchema.
 */
export function parseOrigin(
  s: string,
  env: Pick<Env, "ENVIRONMENT">,
): string | null {
  if (typeof s !== "string" || s.length > 512) return null;
  const m = SHAPE.exec(s.toLowerCase());
  if (!m) return null;
  const [, scheme, host = "", port] = m;
  if (!host.startsWith("[") && host.split(".").some((l) => l === ""))
    return null;
  if (port !== undefined && Number(port) > 65535) return null;
  if (scheme === "http" && !(env.ENVIRONMENT === "dev" && LOOPBACK.has(host)))
    return null;
  let u: URL;
  try {
    u = new URL(`${scheme}://${host}${port ? `:${port}` : ""}`);
  } catch {
    return null;
  }
  if (u.hostname !== host) return null;
  return OriginSchema.safeParse(u.origin).success ? u.origin : null;
}
