// B4's "Not you?" on a real Worker, in a real browser (CSP form-action is
// enforced on every redirect hop, in Chromium).
//
// DESTRUCTIVE TO THE SESSION. Logout signs out EVERYWHERE (#154 bumps the
// session generation), so this kills the shared staging storageState for every
// browser and for Platform's I7. Gated behind E2E_NOT_YOU=1. Chromium only
// (it applies form-action to redirects; each run consumes the owner's login),
// so run `--project chromium`. The device code is left unapproved; it expires.
import { DeviceCodeResponseSchema, R } from "@ob/shared";
import { expect, test, watchErrors } from "./fixtures";

test.skip(
  process.env.E2E_NOT_YOU !== "1",
  "destructive: logout ends every session (set E2E_NOT_YOU=1)",
);

test.beforeEach(({ browserName }) => {
  test.skip(
    browserName !== "chromium",
    "Not you? is Chromium-only: Chromium applies form-action to redirects; each run consumes the owner's login",
  );
});

const teamDomain =
  process.env.E2E_ACCESS_TEAM_DOMAIN || process.env.STAGING_ACCESS_TEAM_DOMAIN;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

test('"Not you?" signs out and leaves for sign-in without a CSP violation', async ({
  signedIn: page,
  baseURL,
}) => {
  const local = LOOPBACK.includes(new URL(baseURL ?? "").hostname);
  // A real deployment must prove the form-action host and the Access landing.
  expect(
    local || teamDomain,
    "non-loopback target: set E2E_ACCESS_TEAM_DOMAIN (or STAGING_ACCESS_TEAM_DOMAIN)",
  ).toBeTruthy();
  const errors = watchErrors(page);

  const minted = await page.request.post(R.deviceCode, {
    data: { machine_label: "e2e-not-you" },
  });
  expect(minted.status()).toBeLessThan(300);
  const { user_code } = DeviceCodeResponseSchema.parse(await minted.json());

  const res = await page.goto(R.approve(user_code));
  expect(res?.status()).toBe(200);
  const csp = (await res?.headerValue("content-security-policy")) ?? "";
  const sources = (/form-action ([^;]*)/.exec(csp)?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  expect(sources).toContain("'self'");
  if (teamDomain) expect(sources).toContain(`https://${teamDomain}`);

  const visited: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest()) visited.push(r.url());
  });
  await page.getByRole("button", { name: "Not you?" }).click();

  if (teamDomain) {
    // Staging: logout -> /auth/login -> the Access sign-in.
    await page.waitForURL((u) => u.hostname === teamDomain);
  } else {
    // Dev has no Access: the chain still passes the Worker's /auth/login on its
    // way to the (unreachable) configured team domain.
    await expect
      .poll(() => visited.some((u) => new URL(u).pathname === "/auth/login"))
      .toBe(true);
  }

  // Let later hops finish loading before judging: a violation can land late.
  await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(500);
  expect(
    errors.filter((e) => /content security policy|form-action/i.test(e)),
    "CSP violations",
  ).toEqual([]);

  // The session is gone for this context.
  const me = await page.request.get(new URL(R.me, baseURL).href, {
    maxRedirects: 0,
  });
  expect(me.status()).toBe(401);
});
