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

/**
 * Console errors and uncaught page errors, from now on. CSP violations log as
 * console errors. With `onlyHost`, console errors count only when reported by a
 * document on that host (the message's source URL, else the page URL at the
 * time of the event): the test judges OUR CSP, not a third party's, such as
 * Cloudflare Access's own sign-in page blocking its logo `data:` image.
 */
export const watchErrors = (page: Page, onlyHost?: string) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Policy-delivery warning for a report-only CSP (#203): not a violation.
    // Goes away once the SPA CSP enforces.
    if (
      /delivered in report-only mode, but does not specify a 'report-to'/.test(
        m.text(),
      )
    )
      return;
    if (onlyHost) {
      let host = "";
      try {
        host = new URL(m.location().url || page.url()).host;
      } catch {}
      if (host !== onlyHost) return;
    }
    errors.push(`console: ${m.text()}`);
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
