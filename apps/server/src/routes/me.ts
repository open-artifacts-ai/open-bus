import { MeSchema, R } from "@ob/shared";
import type { Context } from "hono";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import type { AppType } from "./types.js";

/**
 * The signed-in owner as the dashboard routes need it. B2b's session
 * middleware sets the `session` variable; until then nothing does, so every
 * caller answers 401.
 */
export type OwnerSession = { uid: string; email: string; name?: string | null };

/**
 * The one place the dashboard routes read the session (wired to B2b here).
 * Null when absent or malformed: callers answer 401, never relying solely on
 * the route-policy gate.
 */
export function ownerOf(c: Context<AppEnv>): OwnerSession | null {
  const s = (c.var as Record<string, unknown>).session as
    | Partial<OwnerSession>
    | undefined;
  if (!s || typeof s.uid !== "string" || typeof s.email !== "string")
    return null;
  return { uid: s.uid, email: s.email, name: s.name ?? null };
}

/** Throws the standard 401 envelope when there is no session. */
export function requireOwner(c: Context<AppEnv>): OwnerSession {
  const s = ownerOf(c);
  if (!s) throw new ApiError("unauthorized", "Sign in to continue");
  return s;
}

export function mountMe(app: AppType): void {
  app.get(R.me, (c) => {
    const s = requireOwner(c);
    return c.json(
      MeSchema.parse({
        user: { id: s.uid, email: s.email, name: s.name ?? null },
      }),
    );
  });
}
