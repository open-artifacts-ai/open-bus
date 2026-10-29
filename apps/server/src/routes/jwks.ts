import { R } from "@ob/shared";
import { loadCardKeys, TestKeyError } from "../card/keys.js";
import { errorJson } from "../http/errors.js";
import type { AppType } from "./types.js";

const unavailable = () =>
  errorJson(503, "internal", "Card keys unavailable", undefined, {
    "cache-control": "no-store",
  });

/** The card verification keys: current first, then PREV (public halves only). */
export function mountJwks(app: AppType): void {
  app.get(R.jwks, async (c) => {
    let keys: Awaited<ReturnType<typeof loadCardKeys>>;
    try {
      keys = await loadCardKeys(c.env);
    } catch (e) {
      if (e instanceof TestKeyError) return unavailable();
      throw e;
    }
    if (!keys) return unavailable();
    return c.json(keys.jwks, 200, {
      "cache-control": "public, max-age=3600",
    });
  });
}
