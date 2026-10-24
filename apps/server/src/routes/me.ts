import { MeSchema, R } from "@ob/shared";
import type { Context } from "hono";
import { ApiError } from "../http/errors.js";
import type { AppEnv } from "../http/middleware.js";
import type { AppType } from "./types.js";

/**
 * The signed-in owner as the dashboard routes need it. B2b's session
 * middleware sets the `session` variable (B1's `Session`: `uid`, no email);
 * until then nothing does, so every caller answers 401.
 */
export type OwnerSession = { uid: string; name: string | null };

/**
 * The one place the dashboard routes read the session (wired to B2b here).
 * Null when absent or malformed (a bad shape is a 401, never a 500): callers
 * answer 401, never relying solely on the route-policy gate.
 */
export function ownerOf(c: Context<AppEnv>): OwnerSession | null {
  const s: unknown = (c.var as Record<string, unknown>).session;
  if (typeof s !== "object" || s === null) return null;
  const { uid, name } = s as { uid?: unknown; name?: unknown };
  if (typeof uid !== "string") return null;
  if (name !== undefined && name !== null && typeof name !== "string")
    return null;
  return { uid, name: name ?? null };
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
    // Read only after the session check. OWNER_EMAIL arrives with B1's Env
    // row; until then it is read untyped. Missing or invalid: 500 internal.
    const email = (c.env as { OWNER_EMAIL?: unknown }).OWNER_EMAIL;
    const me = MeSchema.safeParse({
      user: {
        id: s.uid,
        email: typeof email === "string" ? email.trim() : "",
        name: s.name,
      },
    });
    if (!me.success) throw new ApiError("internal", "Owner email is not set");
    return c.json(me.data);
  });
}
