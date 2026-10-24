import {
  ApprovalBodySchema,
  formatUserCode,
  normalizeUserCode,
  R,
} from "@ob/shared";
import { approveCsrf } from "../auth/approve-csrf.js";
import { ApiError } from "../http/errors.js";
import { clientIp, enforceRateLimit } from "../http/rate-limit.js";
import { hub } from "../hub/stub.js";
import {
  type PageBase,
  pageBase,
  renderApprove,
  renderDenied,
  renderGone,
  renderLimited,
  switchUrl,
} from "./approve-page.js";
import { HTML_CSP } from "./auth.js";
import type { AppType } from "./types.js";

/** Per-user HTML: never cached, B1b's strict CSP. */
const html = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": HTML_CSP,
    },
  });

/** The stored (formatted) code, or null when the path cannot be one. */
const codeOf = (param: string): string | null => {
  const raw = param.length <= 32 ? normalizeUserCode(param) : null;
  return raw === null ? null : formatUserCode(raw);
};

const refused = (base: PageBase, reason: "gone" | "limited") =>
  reason === "limited"
    ? html(renderLimited(base), 429)
    : html(renderGone(base), 404);

/**
 * The browser's half of the device flow (B4). Both rows are `{session}`: the
 * gate has already read the session (a signed-out GET is sent to sign-in),
 * and for the POST checked same-origin plus the signed form token bound to
 * this code and session (form-POST CSRF mode). Unknown, expired, decided and
 * redeemed codes render one identical page (404); the session's failed
 * lookups are capped in the hub (APPROVE_FAIL_CAP), the IP by RL_DEVICE.
 */
export function mountApprove(app: AppType): void {
  app.get("/approve/:user_code", async (c) => {
    await enforceRateLimit(c.env.RL_DEVICE, "approve", clientIp(c.req.raw));
    const s = c.get("session");
    const base = pageBase(c.env);
    const code = codeOf(c.req.param("user_code"));
    if (code === null) return refused(base, "gone");
    const r = await hub(c.env).deviceForApproval(code, s.gen);
    if (!r.ok) return refused(base, r.reason);
    return html(
      renderApprove({
        ...base,
        userCode: r.userCode,
        label: r.label,
        csrf: await approveCsrf(c.env, r.userCode, s),
        formAction: R.approve(r.userCode),
        switchUrl: switchUrl(c.env, r.userCode),
      }),
      200,
    );
  });

  app.post("/approve/:user_code", async (c) => {
    await enforceRateLimit(c.env.RL_DEVICE, "approve", clientIp(c.req.raw));
    const s = c.get("session");
    const base = pageBase(c.env);
    // The gate verified the form token for this path's code, so it parses.
    const code = codeOf(c.req.param("user_code"));
    if (code === null) return refused(base, "gone");
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
    if (!r.ok) return refused(base, r.reason);
    if (body.data.decision === "deny")
      return html(renderDenied({ ...base, label: r.label }), 200);
    return new Response(null, {
      status: 303,
      headers: { location: R.dashboard, "cache-control": "no-store" },
    });
  });
}
