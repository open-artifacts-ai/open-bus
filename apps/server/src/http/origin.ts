import type { Env } from "../env.js";
import { appOrigin } from "./errors.js";

/** `hostname` as WHATWG URL serializes it (IPv6 keeps its brackets). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Dev on a loopback host: the only place http origins are accepted. */
export const devLoopback = (env: Pick<Env, "ENVIRONMENT">, url: URL) =>
  env.ENVIRONMENT === "dev" && LOOPBACK.has(url.hostname);

/**
 * Same-origin only (B1b's rule, shared by logout and the B2b gate): an
 * `Origin` header must be exactly the app origin (https), or, in dev on a
 * loopback host only, this request's own `http://host[:port]`. Without an
 * Origin, `Sec-Fetch-Site` must be `same-origin`. Anything else, including
 * neither header, is refused.
 */
export function isSameOrigin(
  env: Pick<Env, "APP_HOST" | "ENVIRONMENT">,
  req: Request,
): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) {
    if (origin === appOrigin(env)) return true;
    const url = new URL(req.url);
    return (
      devLoopback(env, url) &&
      url.protocol === "http:" &&
      origin === `http://${url.host}`
    );
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
}
