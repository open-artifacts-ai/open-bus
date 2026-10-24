// B4's "Not you?" on a real Worker, in a real browser (CSP form-action is
// enforced on every redirect hop, in Chromium).
//
// DESTRUCTIVE TO THE SESSION. Logout signs out EVERYWHERE (#154 bumps the
// session generation), so this kills the shared staging storageState for every
// browser and for Platform's I7. Gated behind E2E_NOT_YOU=1. Run one project at
// a time (`--project chromium`, then `--project webkit`), each needing a fresh
// login. The device code is left unapproved; it expires on its own.
import { DeviceCodeResponseSchema, R } from "@ob/shared";
import { expect, test, watchErrors } from "./fixtures";

test.skip(
  process.env.E2E_NOT_YOU !== "1",
  "destructive: logout ends every session (set E2E_NOT_YOU=1; one project at a time)",
);

const teamDomain =
  process.env.E2E_ACCESS_TEAM_DOMAIN || process.env.STAGING_ACCESS_TEAM_DOMAIN;

test('"Not you?" signs out and leaves for sign-in without a CSP violation', async ({
  signedIn: page,
  baseURL,
}) => {
  const errors = watchErrors(page);

  const minted = await page.request.post(R.deviceCode, {
    data: { machine_label: "e2e-not-you" },
  });
  expect(minted.status()).toBeLessThan(300);
  const { user_code } = DeviceCodeResponseSchema.parse(await minted.json());

  const res = await page.goto(R.approve(user_code));
  expect(res?.status()).toBe(200);
  const csp = (await res?.headerValue("content-security-policy")) ?? "";
  const formAction = /form-action ([^;]*)/.exec(csp)?.[1] ?? "";
  expect(formAction).toContain("'self'");
  if (teamDomain) expect(formAction).toContain(`https://${teamDomain}`);
  else
    test.info().annotations.push({
      type: "skipped",
      description:
        "form-action host assertion: no E2E_ACCESS_TEAM_DOMAIN / STAGING_ACCESS_TEAM_DOMAIN",
    });

  await page.getByRole("button", { name: "Not you?" }).click();

  if (teamDomain) {
    // Staging: logout -> /auth/login -> the Access sign-in.
    await page.waitForURL((u) => u.hostname === teamDomain);
  } else {
    // Dev has no Access: it ends on the Worker's own /auth/login hop.
    await page.waitForURL((u) => u.pathname.startsWith("/auth/"));
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? "").origin);
  }

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
