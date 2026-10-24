// Leaving a session: Sign out, and a 401 in the middle of one. Both land on
// sign-in with nothing of the previous session left on screen.
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { machineRow, openLive } from "./helpers";

const signInHeading = (page: Page) =>
  page.getByRole("heading", { name: "Sign in" });

test("Sign out ends the session and shows sign-in", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/auth/logout")
      posts.push(r.headers()["x-ob-request"] ?? "");
  });
  await openLive(page, "/");
  await expect(machineRow(page, "studio-mbp")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(signInHeading(page)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Cloudflare Access" }),
  ).toBeVisible();
  await expect(page.getByText("studio-mbp")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  expect(posts).toEqual(["1"]);
});

test("a 401 mid-session signs the owner out without an error", async ({
  page,
}) => {
  // Once `__obExpired` is set, every API call answers 401, as the Worker
  // does for a session that ran out.
  await page.addInitScript(() => {
    const w = window as unknown as { __obExpired?: boolean };
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const req = new Request(input, init);
      if (w.__obExpired && new URL(req.url).pathname.startsWith("/api/"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "unauthorized", message: "Sign in" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
        );
      return real(input, init);
    };
  });
  await openLive(page, "/");
  await expect(machineRow(page, "studio-mbp")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __obExpired: boolean }).__obExpired = true;
  });
  // The next call, a revoke, gets the 401.
  await page.getByRole("button", { name: "Revoke studio-mbp" }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke machine" })
    .click();
  await expect(signInHeading(page)).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText(/couldn't revoke/i)).toHaveCount(0);
  await expect(page.getByText("studio-mbp")).toHaveCount(0);
});

test("the hub ending the session (close 4401) shows sign-in without a reconnect", async ({
  page,
}) => {
  await openLive(page, "/");
  await expect(machineRow(page, "studio-mbp")).toBeVisible();
  await page.evaluate(() => window.__obMock?.closeAll(4401));
  await expect(signInHeading(page)).toBeVisible();
  await expect(page.getByText("studio-mbp")).toHaveCount(0);
  await expect(page.getByText("Live updates paused.")).toHaveCount(0);
});
