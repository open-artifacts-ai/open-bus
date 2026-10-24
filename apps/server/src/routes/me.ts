import { MeSchema, R } from "@ob/shared";
import type { Context, MiddlewareHandler } from "hono";
import { mw } from "../auth/route-policy.js";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import type { AppType } from "./types.js";

/**
 * The signed-in owner as the dashboard routes need it. B2b's session
 * middleware sets the `session` variable (B1's `Session`: `uid`, no email);
 * until then nothing does, so every caller answers 401.
 */
export type OwnerSession = {
  uid: string;
  name: string | null;
  /** B1's `Session.exp`: expiry in epoch ms; null when the session has none. */
  exp: number | null;
  /** B1's `Session.gen`: the session generation; null when it has none. */
  gen: number | null;
};

/**
 * The one place the dashboard routes read the session (wired to B2b here).
 * Null when absent or malformed (a bad shape is a 401, never a 500): callers
 * answer 401, never relying solely on the route-policy gate.
 */
export function ownerOf(c: Context<AppEnv>): OwnerSession | null {
  const s: unknown = (c.var as Record<string, unknown>).session;
  if (typeof s !== "object" || s === null) return null;
  const { uid, name, exp, gen } = s as {
    uid?: unknown;
    name?: unknown;
    exp?: unknown;
    gen?: unknown;
  };
  if (typeof uid !== "string") return null;
  if (name !== undefined && name !== null && typeof name !== "string")
    return null;
  if (exp !== undefined && !(Number.isSafeInteger(exp) && (exp as number) > 0))
    return null;
  if (gen !== undefined && !(Number.isSafeInteger(gen) && (gen as number) >= 0))
    return null;
  return {
    uid,
    name: name ?? null,
    exp: (exp as number | undefined) ?? null,
    gen: (gen as number | undefined) ?? null,
  };
}

/** Throws the standard 401 envelope when there is no session. */
export function requireOwner(c: Context<AppEnv>): OwnerSession {
  const s = ownerOf(c);
  if (!s) throw new ApiError("unauthorized", "Sign in to continue");
  return s;
}

/**
 * `Cache-Control: no-store` on every response of the route, errors included
 * (onError's response passes back through here). Tagged `mw` for the gate.
 */
export const noStore = (): MiddlewareHandler<AppEnv> =>
  mw(async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

export function mountMe(app: AppType): void {
  app.use(R.me, noStore());
  app.get(R.me, (c) => {
    const s = requireOwner(c);
    // Read only after the session check. OWNER_EMAIL arrives with B1's Env
    // row; until then it is read untyped. Any MeSchema failure: a generic 500.
    const email = (c.env as { OWNER_EMAIL?: unknown }).OWNER_EMAIL;
    const me = MeSchema.safeParse({
      user: {
        id: s.uid,
        email: typeof email === "string" ? email.trim() : "",
        name: s.name,
      },
    });
    if (!me.success)
      throw new ApiError("internal", "Owner profile unavailable");
    return c.json(me.data);
  });
}
