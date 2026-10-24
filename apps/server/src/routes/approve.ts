import {
  ApprovalBodySchema,
  formatUserCode,
  normalizeUserCode,
  R,
} from "@ob/shared";
import { approveCsrf } from "../auth/approve-csrf.js";
import type { Env } from "../env.js";
import { ApiError } from "../http/errors.js";
import { clientIp, clientKey, enforceRateLimit } from "../http/rate-limit.js";
import { hub } from "../hub/stub.js";
import {
  type PageBase,
  pageBase,
  REFERRER_POLICY,
  renderApprove,
  renderDenied,
  renderGone,
  renderLimited,
  switchUrl,
} from "./approve-page.js";
import { HTML_CSP } from "./auth.js";
import type { AppType } from "./types.js";

/** A DNS hostname (no scheme, port, path or CSP metacharacters). */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * B1b's strict CSP, with the Access team origin added to form-action (adv-B4
 * M2): "Not you?" is a form POST to logout whose redirects end at Access
 * (logout -> /auth/login -> the IdP), and Chromium applies form-action to
 * every hop. Built from ACCESS_TEAM_DOMAIN, only when it is a plain hostname;
 * otherwise form-action stays 'self'.
 */
export function approveCsp(env: Pick<Env, "ACCESS_TEAM_DOMAIN">): string {
  const team = env.ACCESS_TEAM_DOMAIN;
  if (typeof team !== "string" || !HOSTNAME.test(team)) return HTML_CSP;
  return HTML_CSP.replace(
    "form-action 'self'",
    `form-action 'self' https://${team.toLowerCase()}`,
  );
}

/** Per-user HTML: never cached, the approval CSP and referrer policy. */
const html = (
  env: Pick<Env, "ACCESS_TEAM_DOMAIN">,
  body: string,
  status: number,
) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": approveCsp(env),
      "referrer-policy": REFERRER_POLICY,
    },
  });

/** The stored (formatted) code, or null when the path cannot be one. */
const codeOf = (param: string): string | null => {
  const raw = param.length <= 32 ? normalizeUserCode(param) : null;
  return raw === null ? null : formatUserCode(raw);
};

const refused = (
  env: Pick<Env, "ACCESS_TEAM_DOMAIN">,
  base: PageBase,
  reason: "gone" | "limited",
) =>
  reason === "limited"
    ? html(env, renderLimited(base), 429)
    : html(env, renderGone(base), 404);

/**
 * The browser's half of the device flow (B4). Both rows are `{session}`: the
 * gate has already read the session (a signed-out GET is sent to sign-in),
 * and for the POST checked same-origin plus the signed form token bound to
 * this code and session (form-POST CSRF mode). Unknown, expired, decided and
 * redeemed codes render one identical page (404); the session's failed
 * decisions (POST misses only) are capped in the hub (APPROVE_FAIL_CAP),
 * the IP (/64 for IPv6, clientKey) by RL_DEVICE.
 *
 * GET misses are not capped per session (adv-B4 L1 ruling). Enumerating user
 * codes with GET still requires the owner's session (a {session} row), and
 * whoever holds it could mint and approve their own code anyway; per-IP
 * RL_DEVICE bounds the rate. RL_DEVICE is bound on staging by Platform's #181.
 */
export function mountApprove(app: AppType): void {
  app.get("/approve/:user_code", async (c) => {
    await enforceRateLimit(
      c.env.RL_DEVICE,
      "approve",
      clientKey(clientIp(c.req.raw)),
    );
    const s = c.get("session");
    const base = pageBase(c.env);
    const code = codeOf(c.req.param("user_code"));
    if (code === null) return refused(c.env, base, "gone");
    const r = await hub(c.env).deviceForApproval(code, s.gen);
    if (!r.ok) return refused(c.env, base, r.reason);
    return html(
      c.env,
      renderApprove({
        ...base,
        userCode: r.userCode,
        label: r.label,
        ageMs: r.ageMs,
        csrf: await approveCsrf(c.env, r.userCode, s),
        formAction: R.approve(r.userCode),
        switchUrl: switchUrl(c.env, r.userCode),
      }),
      200,
    );
  });

  app.post("/approve/:user_code", async (c) => {
    await enforceRateLimit(
      c.env.RL_DEVICE,
      "approve",
      clientKey(clientIp(c.req.raw)),
    );
    const s = c.get("session");
    const base = pageBase(c.env);
    // The gate verified the form token for this path's code, so it parses.
    const code = codeOf(c.req.param("user_code"));
    if (code === null) return refused(c.env, base, "gone");
    const form = new URLSearchParams(await c.req.text());
    const decisions = form.getAll("decision");
    const labels = form.getAll("label");
    const body = ApprovalBodySchema.safeParse({
      decision: decisions.length === 1 ? decisions[0] : undefined,
      ...(labels.length === 1 && labels[0] !== "" ? { label: labels[0] } : {}),
    });
    if (!body.success || labels.length > 1)
      throw new ApiError("bad_request", "Invalid decision");
    const h = hub(c.env);
    const r =
      body.data.decision === "approve"
        ? await h.approveDevice(code, s.gen, body.data.label)
        : await h.denyDevice(code, s.gen);
    if (!r.ok) return refused(c.env, base, r.reason);
    if (body.data.decision === "deny")
      return html(c.env, renderDenied({ ...base, label: r.label }), 200);
    return new Response(null, {
      status: 303,
      headers: { location: R.dashboard, "cache-control": "no-store" },
    });
  });
}
