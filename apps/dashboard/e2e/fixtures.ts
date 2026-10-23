import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";

/**
 * Every spec's `test`. tokens.css @imports Geist from Google Fonts, and the
 * page's load event waits for it: one slow font request timed out page.goto.
 * Answer it locally with an empty stylesheet (system fonts), so the suite
 * never depends on the network.
 */
export const test = base.extend<{ localFonts: undefined }>({
  localFonts: [
    async ({ context }, use) => {
      await context.route(
        /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
        (route) =>
          route.fulfill({ status: 200, contentType: "text/css", body: "" }),
      );
      await use(undefined);
    },
    { auto: true },
  ],
});
