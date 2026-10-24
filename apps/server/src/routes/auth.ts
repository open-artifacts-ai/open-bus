import { AUTH } from "@ob/shared";
import { getCookie } from "hono/cookie";
import {
  buildAuthorizeRedirect,
  clearOidcCookie,
  handleCallback,
  isOwner,
  OidcStateError,
  pickStateCookie,
  safeNext,
} from "../auth/oidc.js";
import {
  clearSessionCookie,
  readSession,
  sessionCookie,
  sessionCookieName,
  signSession,
} from "../auth/session.js";
import type { Env } from "../env.js";
import { appOrigin, errorJson, toErrorResponse } from "../http/errors.js";
import { hub } from "../hub/stub.js";
import type { AppType } from "./types.js";

export const NO_ACCESS = "/auth/no-access";

/** Every sign-in response is per-user and must never be cached. */
const NO_STORE = "no-store";

export const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const withCookies = (h: Headers, cookies: string[]) => {
  for (const c of cookies) h.append("set-cookie", c);
  return h;
};

const redirect = (location: string, cookies: string[] = []) =>
  new Response(null, {
    status: 302,
    headers: withCookies(
      new Headers({ location, "cache-control": NO_STORE }),
      cookies,
    ),
  });

const html = (body: string, status: number, cookies: string[] = []) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenBus</title></head><body>${body}</body></html>`,
    {
      status,
      headers: withCookies(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": NO_STORE,
          "content-security-policy": HTML_CSP,
        }),
        cookies,
      ),
    },
  );

/** The same 404 whichever dev-login condition failed. */
const notFound = () =>
  errorJson(404, "not_found", "Not found", undefined, {
    "cache-control": NO_STORE,
  });

/** `hostname` as WHATWG URL serializes it (IPv6 keeps its brackets). */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Same-origin only (logout CSRF guard until B2b's middleware): an `Origin`
 * header must be exactly the app origin; without one, `Sec-Fetch-Site` must
 * be `same-origin`. Anything else, including neither header, is refused.
 */
function sameOrigin(env: Env, req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) return origin === appOrigin(env);
  return req.headers.get("sec-fetch-site") === "same-origin";
}

export function mountAuth(app: AppType): void {
  app.get(AUTH.login, async (c) => {
    const { location, stateCookie, evict } = await buildAuthorizeRedirect(
      c.env,
      safeNext(c.env, c.req.query("next")),
      {
        retry: c.req.query("retry") === "1",
        cookieHeader: c.req.header("cookie"),
      },
    );
    return redirect(location, [...evict, stateCookie]);
  });

  app.get(AUTH.callback, async (c) => {
    // This attempt's state cookie is single-use: cleared on success and on every failure.
    const picked = await pickStateCookie(
      c.env,
      c.req.raw,
      c.req.query("state") ?? "",
    );
    const clear = picked ? [clearOidcCookie(c.env, picked.name)] : [];
    try {
      const { email, next } = await handleCallback(c.env, c.req.raw);
      if (!isOwner(c.env, email)) return redirect(NO_ACCESS, clear);
      return redirect(safeNext(c.env, next), [
        ...clear,
        sessionCookie(await signSession(c.env), c.env),
      ]);
    } catch (e) {
      if (e instanceof OidcStateError) {
        if (e.retry)
          return html(
            "<h1>Sign-in interrupted</h1><p>Try again.</p>",
            400,
            clear,
          );
        return redirect(
          `${AUTH.login}?next=${encodeURIComponent(safeNext(c.env, e.next))}&retry=1`,
          clear,
        );
      }
      // Any other failure: the app's standard error envelope (as onError
      // answers it), still clearing the state cookie and never cached.
      const res = toErrorResponse(e);
      res.headers.set("cache-control", NO_STORE);
      withCookies(res.headers, clear);
      return res;
    }
  });

  app.get(NO_ACCESS, () =>
    html(
      "<h1>Not your bus</h1><p>This instance belongs to another owner.</p>",
      403,
    ),
  );

  app.post(AUTH.logout, async (c) => {
    if (!sameOrigin(c.env, c.req.raw))
      return errorJson(403, "csrf", "Cross-origin request refused", undefined, {
        "cache-control": NO_STORE,
      });
    const current = await readSession(
      c.env,
      getCookie(c, sessionCookieName(c.env)),
    );
    // Signs out every session, not only this browser's.
    if (current) await hub(c.env).bumpSessionGeneration();
    return new Response(null, {
      status: 204,
      headers: {
        "set-cookie": clearSessionCookie(c.env),
        "cache-control": NO_STORE,
      },
    });
  });

  app.get(AUTH.devLogin, async (c) => {
    if (
      c.env.ENVIRONMENT !== "dev" ||
      !LOOPBACK.has(new URL(c.req.url).hostname)
    )
      return notFound();
    return redirect(safeNext(c.env, c.req.query("next")), [
      sessionCookie(await signSession(c.env), c.env),
    ]);
  });
}
