import type { MiddlewareHandler } from "hono";
import { SERVER_TEST_CARD_KEY_X } from "../card/keys.js";
import type { Env } from "../env.js";
import { logEvent } from "../util/log.js";
import type { AppEnv } from "./middleware.js";

/** The `problem` /healthz reports; `status` and `doctor` print its fix (#297). */
export const TEST_CARD_KEY_PROBLEM = "test_card_key";

const xOf = (jwk: string | undefined): unknown => {
  if (!jwk) return undefined;
  try {
    return (JSON.parse(jwk) as { x?: unknown }).x;
  } catch {
    return undefined;
  }
};

/**
 * True outside ENVIRONMENT=dev when CARD_SIGNING_KEY or CARD_SIGNING_KEY_PREV
 * is the shared test key (I11). Checked on the raw secrets, not through
 * loadCardKeys, so a bus missing its salt or holding a malformed key still
 * refuses. A Worker has no start to refuse, so every request refuses instead.
 */
export function onTestCardKey(env: Env): boolean {
  if (env.ENVIRONMENT === "dev") return false;
  return [env.CARD_SIGNING_KEY, env.CARD_SIGNING_KEY_PREV].some(
    (k) => xOf(k) === SERVER_TEST_CARD_KEY_X,
  );
}

/** One log line per isolate: loud enough to find, never a flood. */
let logged = false;

/**
 * 503 on everything but GET /healthz, which keeps answering with
 * `problem: "test_card_key"` so `status` and `doctor` can say why and how to
 * fix it. Never a silent outage, and never any key material in the log.
 */
export const cardKeyGuard =
  (): MiddlewareHandler<AppEnv> => async (c, next) => {
    if (!onTestCardKey(c.env)) return next();
    if (!logged) {
      logged = true;
      logEvent("card_key_is_test_key", {
        action: "refusing requests; see docs/ops/releases.md",
      });
    }
    if (c.req.method === "GET" && new URL(c.req.url).pathname === "/healthz")
      return next();
    return c.text(
      "This bus's card key is the shared test key. Run: pnpm -s ob:setup --name <instance> --rotate-card-key --force\n",
      503,
    );
  };

/** Test seam: forget that the line was logged. */
export const resetCardKeyGuardLog = () => {
  logged = false;
};
