import { AUTH } from "@ob/shared";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { Env } from "../env.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { hub } from "../hub/stub.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../util/crypto.js";
import { deriveKey } from "./keys.js";

/*
 * Cloudflare Access for SaaS (OIDC) sign-in, copied from Open Artifacts and
 * reduced to its one provider.
 *
 * Each login attempt gets its own signed cookie `__Host-ob_oidc_<k>` (dev over
 * http: plain `ob_oidc_<k>`, Path=/auth), where k = first 10 base64url chars of
 * sha256(state). The callback recomputes k from the `state` query param to pick
 * the cookie, then still verifies the HMAC and compares state in constant time.
 * Parallel tabs therefore don't clobber each other, and at most MAX_ATTEMPTS
 * cookies are kept (oldest by signed exp evicted at login; unparseable first).
 *
 * Security (login CSRF / cookie tossing): a callback is accepted only if its
 * `state` equals the state inside an HMAC-signed cookie this browser presents.
 * The HMAC alone does not bind the cookie to a browser: an attacker can run
 * /auth/login themselves and obtain a valid (state, cookie) pair. What stops
 * them is that they cannot make the victim's browser *hold* that cookie. The
 * `__Host-` prefix forbids a sibling or parent-domain host from planting or
 * overwriting one, so the prefixed name is the only one read in production.
 * k is a public hash prefix, not a secret; nothing is accepted on k alone.
 *
 * State cookies are signed with deriveKey("ob:oidc-state").
 *
 * State failures (missing / bad sig / expired / mismatch) redirect once to
 * /auth/login?retry=1. The retry flag rides in the signed payload and as a
 * public `r1.` prefix on `state` (so it survives even if the cookie never comes
 * back); a second state failure renders a static page instead: no loop.
 */
const OIDC_BASE = "ob_oidc_";
const hostPrefixed = (env: Env) => env.ENVIRONMENT !== "dev";
const oidcPrefix = (env: Env) =>
  hostPrefixed(env) ? `__Host-${OIDC_BASE}` : OIDC_BASE;
const oidcNameRe = (env: Env) =>
  new RegExp(`^${oidcPrefix(env)}[A-Za-z0-9_-]{10}$`);
/** Browsers silently drop cookies over ~4096 bytes; stay well under. */
const MAX_SET_COOKIE_LEN = 3800;
const OIDC_MAX_AGE_S = 900;
const MAX_ATTEMPTS = 3;
const MAX_SCANNED = 16;
const RETRY_MARK = "r1.";
const MAX_NEXT_LEN = 2048;
const MAX_COOKIE_LEN = 4096;
const CLOCK_TOLERANCE_S = 60;
/** An id_token is used seconds after Access mints it; older (or future-dated) ones are refused. */
const MAX_TOKEN_AGE = "10m";

type OidcState = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
  retry?: boolean;
};

const stateKey = (env: Env) => deriveKey(env, "ob:oidc-state");

/** How many times safeNext percent-decodes before giving up (double encoding and beyond). */
const MAX_DECODES = 4;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A single leading "/", no "//", no backslash, no control character (tab, CR, LF). */
const unsafeForm = (p: string) =>
  !p.startsWith("/") ||
  p.startsWith("//") ||
  p.includes("\\") ||
  CONTROL.test(p);

/**
 * True when `p` and every percent-decoding of it are safe forms. Decodes
 * until the value stops changing (at most MAX_DECODES times), so `%2F%2F`,
 * `%5C`, `%09` and their double encodings (`%252F`) are all caught. Malformed
 * percent-encoding is unsafe.
 */
function safeAtEveryLayer(p: string): boolean {
  let cur = p;
  for (let i = 0; ; i++) {
    if (unsafeForm(cur)) return false;
    let dec: string;
    try {
      dec = decodeURIComponent(cur);
    } catch {
      return false;
    }
    if (dec === cur) return true;
    if (i >= MAX_DECODES) return false;
    cur = dec;
  }
}

/**
 * Same-origin path or "/", validated server-side. The value must start with a
 * single "/" and contain no "//" prefix, backslash or control character, both
 * as given and after each percent-decoding. It is then resolved against the
 * app origin and the normalized output is checked the same way (dot segments
 * can resolve to "//host"). The cap applies to the serialized form so the
 * state cookie stays small.
 */
export function safeNext(env: Env, next: string | undefined | null): string {
  if (typeof next !== "string" || next.length > MAX_NEXT_LEN) return "/";
  if (!safeAtEveryLayer(next)) return "/";
  const origin = appOrigin(env);
  try {
    const u = new URL(next, origin);
    if (u.origin !== origin) return "/";
    const out = `${u.pathname}${u.search}${u.hash}`;
    if (out.length > MAX_NEXT_LEN || !safeAtEveryLayer(out)) return "/";
    return out;
  } catch {
    return "/";
  }
}

const randomB64 = (n: number) =>
  b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));

async function s256(v: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return b64urlEncode(new Uint8Array(d));
}

function oidcCookie(
  env: Env,
  name: string,
  value: string,
  maxAge: number,
): string {
  // __Host- requires Secure, Path=/ and no Domain.
  const attrs = hostPrefixed(env)
    ? "HttpOnly; Secure; SameSite=Lax; Path=/"
    : "HttpOnly; SameSite=Lax; Path=/auth";
  return `${name}=${value}; ${attrs}; Max-Age=${maxAge}`;
}

export const clearOidcCookie = (env: Env, name: string) =>
  oidcCookie(env, name, "", 0);

/** Per-attempt cookie name for a state value. */
export async function stateCookieName(
  env: Env,
  state: string,
): Promise<string> {
  return `${oidcPrefix(env)}${(await s256(state)).slice(0, 10)}`;
}

function parseCookies(header: string | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.push([part.slice(0, i).trim(), part.slice(i + 1).trim()]);
  }
  return out;
}

/** Set-Cookie clears for the oldest attempts so that, with the new one, at most MAX_ATTEMPTS remain. */
async function evictions(
  env: Env,
  key: string,
  cookieHeader: string | null | undefined,
): Promise<string[]> {
  const re = oidcNameRe(env);
  const seen = new Map<string, string>();
  for (const [n, v] of parseCookies(cookieHeader))
    if (re.test(n) && !seen.has(n)) seen.set(n, v);
  const excess = seen.size - (MAX_ATTEMPTS - 1);
  if (excess <= 0) return [];
  const ranked: { name: string; exp: number }[] = [];
  let scanned = 0;
  for (const [name, value] of seen) {
    // Bound HMAC work; anything past the cap is treated as unparseable.
    const r = scanned++ < MAX_SCANNED ? await readOidcState(key, value) : null;
    ranked.push({ name, exp: r?.st ? r.st.exp : Number.NEGATIVE_INFINITY });
  }
  ranked.sort((a, b) => a.exp - b.exp);
  return ranked.slice(0, excess).map((x) => clearOidcCookie(env, x.name));
}

export function accessIssuer(env: Env): string {
  return `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${env.ACCESS_CLIENT_ID}`;
}

const redirectUri = (env: Env) => `${appOrigin(env)}${AUTH.callback}`;

function authorizeUrl(
  env: Env,
  a: { state: string; nonce: string; challenge: string },
): string {
  const u = new URL(`${accessIssuer(env)}/authorization`);
  u.search = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri(env),
    state: a.state,
    nonce: a.nonce,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export async function buildAuthorizeRedirect(
  env: Env,
  next: string,
  opts: { retry?: boolean; cookieHeader?: string | null } = {},
): Promise<{ location: string; stateCookie: string; evict: string[] }> {
  const key = await stateKey(env);
  const retry = opts.retry === true;
  const st: OidcState = {
    state: `${retry ? RETRY_MARK : ""}${randomB64(32)}`,
    nonce: randomB64(32),
    verifier: randomB64(32),
    next: safeNext(env, next),
    exp: Date.now() + OIDC_MAX_AGE_S * 1000,
    ...(retry ? { retry: true } : {}),
  };
  const name = await stateCookieName(env, st.state);
  const sign = async () => {
    const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
    return oidcCookie(
      env,
      name,
      `${p}.${await hmacSign(key, p)}`,
      OIDC_MAX_AGE_S,
    );
  };
  // Measure the final Set-Cookie; if the browser would drop it, fall back to "/".
  let stateCookie = await sign();
  if (stateCookie.length > MAX_SET_COOKIE_LEN) {
    st.next = "/";
    stateCookie = await sign();
  }
  return {
    location: authorizeUrl(env, {
      state: st.state,
      nonce: st.nonce,
      challenge: await s256(st.verifier),
    }),
    stateCookie,
    evict: await evictions(env, key, opts.cookieHeader),
  };
}

export const tag = (v: unknown) =>
  typeof v === "string"
    ? v
        .toLowerCase()
        .replace(/[^a-z_]/g, "")
        .slice(0, 64)
    : undefined;

/**
 * Structured failure log. Callers pass only a fixed stage and sanitized
 * enum-like extras: never tokens, codes, emails, state values or secrets.
 */
export function logOidcFail(
  stage: string,
  extra: Record<string, string | undefined> = {},
): void {
  console.warn(JSON.stringify({ ...extra, evt: "oidc_fail", stage }));
}

/** State-cookie failure: the route redirects to a retry login (or the static page). */
export class OidcStateError extends ApiError {
  constructor(
    public next: string,
    public retry: boolean,
    /** The logged state stage ("no_state_cookie", "state_expired", …). */
    public stage: string = "state",
  ) {
    super("unauthorized", "Login failed");
  }
}

/**
 * A refusal after the state cookie checked out: the route knows where the
 * user was going (`next`) and can send them back to the sign-in page.
 */
export class OidcRedeemError extends ApiError {
  constructor(
    public next: string,
    /** The logged failure stage ("jwt_verify", "nonce", …), when known. */
    public stage: string | null,
  ) {
    super("unauthorized", "Login failed");
  }
}

/** ApiError("unauthorized") that remembers its (already logged) stage. */
class OidcFailure extends ApiError {
  constructor(public stage: string) {
    super("unauthorized", "Login failed");
  }
}

export const fail = (
  stage: string,
  extra?: Record<string, string | undefined>,
): never => {
  logOidcFail(stage, extra);
  throw new OidcFailure(stage);
};

/** The cookie for this attempt (by state), else null. */
export async function pickStateCookie(
  env: Env,
  req: Request,
  state: string,
): Promise<{ name: string; value: string } | null> {
  const name = await stateCookieName(env, state);
  const hit = parseCookies(req.headers.get("cookie")).find(([n]) => n === name);
  return hit ? { name, value: hit[1] } : null;
}

type StateRead =
  | { stage: null; st: OidcState }
  | { stage: "state_expired"; st: OidcState }
  | { stage: "state_bad_sig"; st?: undefined };

/** HMAC-verified payload; expired payloads are returned (for `next`/`retry`) but flagged. */
async function readOidcState(key: string, value: string): Promise<StateRead> {
  const bad = { stage: "state_bad_sig" } as const;
  if (value.length > MAX_COOKIE_LEN) return bad;
  const parts = value.split(".");
  if (parts.length !== 2) return bad;
  const [p, sig] = parts as [string, string];
  if (!(await hmacVerify(key, p, sig))) return bad;
  const raw = b64urlDecode(p);
  if (!raw) return bad;
  try {
    const o = JSON.parse(new TextDecoder().decode(raw)) as Partial<OidcState>;
    if (
      !o ||
      typeof o.state !== "string" ||
      typeof o.nonce !== "string" ||
      typeof o.verifier !== "string" ||
      typeof o.next !== "string" ||
      typeof o.exp !== "number" ||
      !Number.isFinite(o.exp)
    )
      return bad;
    const st = o as OidcState;
    return st.exp <= Date.now()
      ? { stage: "state_expired", st }
      : { stage: null, st };
  } catch {
    return bad;
  }
}

/**
 * Single-use state: the hub records each state once (until its expiry) and
 * answers false on any reuse, so a replayed callback is refused. Called only
 * after the code redeemed (W2). A hub failure throws (the callback fails closed).
 */
async function consumeState(env: Env, st: OidcState): Promise<boolean> {
  return hub(env).consumeState(st.state, st.exp);
}

/**
 * True only when `email` is the owner's, compared ASCII-only and
 * case-insensitively. Any non-ASCII character refuses, so Unicode case
 * mapping (KELVIN SIGN to "k") can never make another address match.
 */
export function isOwner(env: Pick<Env, "OWNER_EMAIL">, email: string): boolean {
  const norm = (s: string) =>
    /^[\x21-\x7e]+$/.test(s.trim()) ? s.trim().toLowerCase() : null;
  const a = norm(email);
  const b = norm(env.OWNER_EMAIL);
  return a !== null && a === b;
}

/** Constant-time string equality via HMAC verify. */
export async function safeEqual(secret: string, a: string, b: string) {
  return hmacVerify(secret, a, await hmacSign(secret, b));
}

/**
 * The IdP's `error` code from a failed token response, as a tag. Never
 * `error_description` or the body: an IdP may echo the code, client id or
 * email there. Access answers token errors with a 302 to
 * redirect_uri?error=…; others use a JSON body.
 */
async function tokenErrorInfo(res: Response): Promise<{ error?: string }> {
  try {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get("location");
      if (!loc) return {};
      const p = new URL(loc, "https://invalid.local").searchParams;
      return { error: tag(p.get("error")) };
    }
    if (res.status >= 400 && res.status < 500) {
      const text = await res.text();
      if (text.length > 16_384) return {};
      const j = JSON.parse(text) as { error?: unknown } | null;
      return { error: tag(j?.error) };
    }
    await res.body?.cancel();
  } catch {
    // non-JSON or malformed: stage alone is logged
  }
  return {};
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(issuer: string) {
  let s = jwksCache.get(issuer);
  if (!s) {
    s = createRemoteJWKSet(new URL(`${issuer}/jwks`));
    jwksCache.set(issuer, s);
  }
  return s;
}

/** What Access vouches for, after every check passed. */
export type VerifiedIdentity = {
  /** Access `sub`. */
  subject: string;
  email: string;
  name: string | null;
};

/** Exchanges the code with Access and verifies the ID token (nonce included). */
async function redeem(
  env: Env,
  key: string,
  a: { code: string; verifier: string; nonce: string },
): Promise<VerifiedIdentity> {
  const issuer = accessIssuer(env);
  let idToken: unknown;
  try {
    const res = await fetch(`${issuer}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: a.code,
        redirect_uri: redirectUri(env),
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
        code_verifier: a.verifier,
      }),
      redirect: "manual",
    });
    if (!res.ok)
      return fail(`token_http_${res.status}`, await tokenErrorInfo(res));
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return fail("token_bad_json");
    }
    idToken = (body as { id_token?: unknown } | null)?.id_token;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail("token_fetch");
  }
  if (typeof idToken !== "string") return fail("no_id_token");

  // Refuse any alg but RS256 before jose sees the token (jose would too, via
  // `algorithms`, but its rejection also surfaces as an unhandled rejection
  // under workerd: log noise).
  try {
    if (decodeProtectedHeader(idToken).alg !== "RS256")
      return fail("jwt_verify", { code: "ERR_JOSE_ALG_NOT_ALLOWED" });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    return fail("jwt_verify", { code: "ERR_JWS_INVALID" });
  }
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(idToken, jwks(issuer), {
      issuer,
      audience: env.ACCESS_CLIENT_ID,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["exp", "iat", "nonce", "sub"],
      maxTokenAge: MAX_TOKEN_AGE,
    }));
  } catch (e) {
    const err = e as { code?: unknown; claim?: unknown };
    return fail("jwt_verify", {
      code:
        typeof err?.code === "string"
          ? err.code.replace(/[^A-Z_]/g, "").slice(0, 64)
          : undefined,
      claim: tag(err?.claim),
    });
  }
  // Access sets aud to the client id; reject multi-audience tokens outright.
  const aud = claims.aud;
  if (
    Array.isArray(aud) &&
    (aud.length !== 1 || aud[0] !== env.ACCESS_CLIENT_ID)
  )
    return fail("aud");
  if (
    typeof claims.nonce !== "string" ||
    !(await safeEqual(key, claims.nonce, a.nonce))
  )
    return fail("nonce");
  const email = claims.email;
  if (typeof email !== "string" || !email.includes("@")) return fail("email");
  // Absent is accepted (Access may omit it); present must be exactly `true`.
  if ("email_verified" in claims && claims.email_verified !== true)
    return fail("email_unverified");
  if (typeof claims.sub !== "string" || claims.sub === "") return fail("sub");
  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim().slice(0, 200)
      : null;
  return {
    subject: claims.sub,
    email: email.trim(),
    name,
  };
}

/**
 * Validates this browser's state cookie, then redeems the code with Access.
 * Throws OidcStateError on state failures (the route retries once) and
 * OidcRedeemError on everything else; never leaks detail. `owner` says
 * whether the verified email is OWNER_EMAIL; the route refuses when it is not.
 */
export async function handleCallback(
  env: Env,
  req: Request,
): Promise<VerifiedIdentity & { next: string; owner: boolean }> {
  const key = await stateKey(env);
  const q = new URL(req.url).searchParams;
  const state = q.get("state") ?? "";
  const failState = (stage: string, from?: OidcState): never => {
    logOidcFail(stage);
    // `next` only from an HMAC-valid payload; retry from it or the public marker.
    throw new OidcStateError(
      safeNext(env, from?.next ?? "/"),
      from?.retry === true || state.startsWith(RETRY_MARK),
      stage,
    );
  };
  const picked = await pickStateCookie(env, req, state);
  if (!picked) return failState("no_state_cookie");
  const read = await readOidcState(key, picked.value);
  if (read.stage === "state_bad_sig") return failState("state_bad_sig");
  if (read.stage === "state_expired")
    return failState("state_expired", read.st);
  const st = read.st;
  if (!(await safeEqual(key, state, st.state)))
    return failState("state_mismatch");
  const next = safeNext(env, st.next);
  let id: VerifiedIdentity;
  try {
    if (q.has("error"))
      return fail("idp_error", { error: tag(q.get("error")) });
    const code = q.get("code");
    if (!code) return fail("no_code");
    id = await redeem(env, key, {
      code,
      verifier: st.verifier,
      nonce: st.nonce,
    });
  } catch (e) {
    if (e instanceof ApiError)
      throw new OidcRedeemError(
        next,
        e instanceof OidcFailure ? e.stage : null,
      );
    throw e;
  }
  // The state is recorded only after redeem succeeds (W2): a callback with
  // no code, an IdP error or a code Access refuses stores nothing, so an
  // anonymous flood cannot fill MAX_OIDC_STATES. A replay is still refused:
  // Access codes are single-use and PKCE-bound, and here consumeState answers
  // false for a state already used (also settling two concurrent callbacks).
  // Refused with the static page, not a retry login (retry = true).
  if (!(await consumeState(env, st))) {
    logOidcFail("state_mismatch", { reason: "replay" });
    throw new OidcStateError(next, true, "state_mismatch");
  }
  return { ...id, next, owner: isOwner(env, id.email) };
}
