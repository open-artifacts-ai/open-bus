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
  sessionCookie,
  sessionCookieName,
  sessionGeneration,
  signSession,
  verifySession,
} from "../auth/session.js";
import { errorJson, toErrorResponse } from "../http/errors.js";
import { devLoopback, isSameOrigin } from "../http/origin.js";
import { clientIp, enforceRateLimit } from "../http/rate-limit.js";
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

/** Dev-login refuses cross-site and same-site fetches; absent (curl, e2e), none and same-origin pass. */
const DEV_LOGIN_FETCH_SITES = new Set(["none", "same-origin"]);

export function mountAuth(app: AppType): void {
  // Login and callback are unauthenticated yet each callback writes one
  // oidc_states row in the owner hub (L3): accepted, rate-limited in B11.
  app.get(AUTH.login, async (c) => {
    // B11's seam (adv-B4 L2): per-IP, fail-open; MAX_OIDC_STATES backs it.
    await enforceRateLimit(c.env.RL_AUTH, "auth", clientIp(c.req.raw));
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
    if (!isSameOrigin(c.env, c.req.raw))
      return errorJson(403, "csrf", "Cross-origin request refused", undefined, {
        "cache-control": NO_STORE,
      });
    const clear = { "set-cookie": clearSessionCookie(c.env) };
    // Signature and claims first: a forged or stale cookie never reaches the hub.
    const current = await verifySession(
      c.env,
      getCookie(c, sessionCookieName(c.env)),
    );
    if (current) {
      try {
        // Signs out every session, not only this browser's.
        if (current.gen === (await sessionGeneration(c.env)))
          await hub(c.env).bumpSessionGeneration();
      } catch {
        // "Sign out everywhere" did not happen: say so, but still drop this cookie.
        console.error(JSON.stringify({ event: "logout_hub_error" }));
        return errorJson(
          500,
          "internal",
          "Signed out here; could not sign out other sessions",
          undefined,
          { ...clear, "cache-control": NO_STORE },
        );
      }
    }
    // B4's "Not you?" form: signed out, go straight back to sign-in. POST
    // only (this route is), after the same origin and session checks; next
    // goes through safeNext, so it can only name a path on this app.
    if (c.req.query("then") === "login")
      return new Response(null, {
        status: 303,
        headers: {
          ...clear,
          location: `${AUTH.login}?next=${encodeURIComponent(safeNext(c.env, c.req.query("next")))}`,
          "cache-control": NO_STORE,
        },
      });
    return new Response(null, {
      status: 204,
      headers: { ...clear, "cache-control": NO_STORE },
    });
  });

  app.get(AUTH.devLogin, async (c) => {
    const site = c.req.header("sec-fetch-site");
    if (
      !devLoopback(c.env, new URL(c.req.url)) ||
      (site !== undefined && !DEV_LOGIN_FETCH_SITES.has(site))
    )
      return notFound();
    return redirect(safeNext(c.env, c.req.query("next")), [
      sessionCookie(await signSession(c.env), c.env),
    ]);
  });
}
