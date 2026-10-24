import { test as base, expect, type Page } from "@playwright/test";

/** True when a staging storageState carries the session (E2E_STORAGE_STATE). */
export const usesStorageState = !!process.env.E2E_STORAGE_STATE;

/**
 * The Worker's dev-only sign-in (GET /auth/dev-login): a 404 unless
 * ENVIRONMENT=dev and the host is loopback. Not used with a storageState.
 */
export const devLogin = async (page: Page) => {
  const res = await page.request.get("/auth/dev-login", { maxRedirects: 0 });
  expect(res.status(), "dev-login: needs ENVIRONMENT=dev on loopback").toBe(
    302,
  );
};

/** Console errors and uncaught page errors, from now on. CSP violations log as console errors. */
export const watchErrors = (page: Page) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
};

export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    if (!usesStorageState) await devLogin(page);
    await use(page);
  },
});
export { expect };
