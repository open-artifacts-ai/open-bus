// REVIEW FOCUS #4, the pinned revoke test: never delete or weaken it.
// Revoking a live machine keeps it listed as Revoked, takes its agents off the
// roster and the Agents count, leaves no second revoke, and treats a 404
// (already revoked) as success. Fixtures: @ob/shared/mocks (studio-mbp is
// live and runs claude-1 and the global scout; laptop runs opencode-1).
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  answerRevoke,
  deletesSent,
  expectCount,
  hubRevokedAt,
  machineRow,
  navLink,
  openLive,
  streamHooks,
} from "./helpers";

const revokeButton = (page: Page, label: string) =>
  page.getByRole("button", { name: `Revoke ${label}`, exact: true });
const dialog = (page: Page, label: string) =>
  page.getByRole("alertdialog", { name: `Revoke “${label}”?` });
const toastFor = (page: Page, text: string) =>
  page.getByRole("region", { name: /Notifications/ }).getByText(text);

test.describe("revoke (pinned)", () => {
  test("revoking a live machine keeps it listed as Revoked and takes its agents off the roster", async ({
    page,
  }) => {
    await openLive(page, "/");
    const row = machineRow(page, "studio-mbp");
    await expect(row.getByText("Live", { exact: true })).toBeVisible();
    await expect(page.getByText(/3 machines · 1 live/)).toBeVisible();
    await expectCount(page, "Agents", 3);

    // The Agents page lists studio-mbp's agents before the revoke.
    await navLink(page, "Agents").click();
    await expect(
      page.getByRole("img", { name: "claude-1 on studio-mbp is live" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "scout on studio-mbp is live" }),
    ).toBeVisible();

    await navLink(page, "Machines").click();
    await revokeButton(page, "studio-mbp").click();
    const dlg = dialog(page, "studio-mbp");
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText("This cannot be undone.");
    // Focus starts on Cancel, never on the destructive button.
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dlg.getByRole("button", { name: "Revoke machine" }).click();

    await expect(dlg).toHaveCount(0);
    await expect(toastFor(page, "studio-mbp revoked")).toBeVisible();
    // The DELETE reached the hub: it, not just the page, has the machine revoked.
    await expect
      .poll(() => hubRevokedAt(page, "studio-mbp"))
      .toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Stays listed, Revoked, with no action left: a second revoke is impossible.
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(row.getByText(/^Revoked [A-Z][a-z]{2} \d/)).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toHaveCount(0);
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(page.getByText(/3 machines · 0 live/)).toBeVisible();
    await expectCount(page, "Machines", 3);

    // Its agents leave the roster and the nav count drops; laptop's stays.
    await expectCount(page, "Agents", 1);
    await navLink(page, "Agents").click();
    await expect(
      page.getByRole("img", { name: "opencode-1 on laptop is queued" }),
    ).toBeVisible();
    await expect(page.getByText("claude-1")).toHaveCount(0);
    await expect(page.getByText("scout")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Global agents" }),
    ).toHaveCount(0);
  });

  test("a 404 (already revoked elsewhere) is treated as success", async ({
    page,
  }) => {
    // The mock revoke applies, then the response is a 404 not_found, as when
    // another tab's revoke landed first.
    await answerRevoke(page, {
      status: 404,
      code: "not_found",
      message: "No such machine",
      applyFirst: true,
    });
    await openLive(page, "/");
    await revokeButton(page, "studio-mbp").click();
    const dlg = dialog(page, "studio-mbp");
    await dlg.getByRole("button", { name: "Revoke machine" }).click();

    await expect(dlg).toHaveCount(0);
    await expect(toastFor(page, "studio-mbp revoked")).toBeVisible();
    await expect(page.getByText(/Couldn't revoke/)).toHaveCount(0);
    const row = machineRow(page, "studio-mbp");
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toHaveCount(0);
    await expectCount(page, "Agents", 1);
  });

  test("the client takes a revoked machine's agents off even when the hub's roster still lists them", async ({
    page,
  }) => {
    // The hub answers 204 and marks the machine revoked, but its agents stay
    // in GET /agents and no agents frame comes: only listedAgents removes them.
    await answerRevoke(page, { machinesOnly: true });
    await openLive(page, "/");
    await expectCount(page, "Agents", 3);
    await revokeButton(page, "studio-mbp").click();
    await dialog(page, "studio-mbp")
      .getByRole("button", { name: "Revoke machine" })
      .click();
    await expect(toastFor(page, "studio-mbp revoked")).toBeVisible();
    await expect(
      machineRow(page, "studio-mbp").getByText("Revoked", { exact: true }),
    ).toBeVisible();
    // The hub's roster still has them, so the page is doing the removing.
    expect(
      await page.evaluate(
        () =>
          window.__obMock
            ?.agents()
            .filter((a) => a.machineLabel === "studio-mbp").length,
      ),
    ).toBe(2);
    await expectCount(page, "Agents", 1);
    await navLink(page, "Agents").click();
    await expect(
      page.getByRole("img", { name: "opencode-1 on laptop is queued" }),
    ).toBeVisible();
    await expect(page.getByText("claude-1")).toHaveCount(0);
    await expect(page.getByText("scout")).toHaveCount(0);
  });

  test("a 404 keeps the row Revoked from the success patch alone (no stream, refetch failing)", async ({
    page,
  }) => {
    // Nothing else can say Revoked: the hub never revokes, the stream is down
    // and every machines GET after the DELETE fails. The upgrade is refused,
    // as for an expired session.
    await streamHooks(page, { blocked: "refused" });
    await answerRevoke(page, {
      status: 404,
      code: "not_found",
      message: "No such machine",
      failRefetch: true,
    });
    await page.goto("/");
    // The refused upgrade reads as a drop: paused, not stuck connecting.
    await expect(
      page.getByRole("status").filter({ hasText: "Live updates paused." }),
    ).toBeVisible();
    await revokeButton(page, "studio-mbp").click();
    await dialog(page, "studio-mbp")
      .getByRole("button", { name: "Revoke machine" })
      .click();
    await expect(toastFor(page, "studio-mbp revoked")).toBeVisible();
    // The refetch and its two retries have failed, so the mutation settled.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __obFailedGets: number }).__obFailedGets,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const row = machineRow(page, "studio-mbp");
    await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toHaveCount(0);
    expect(await hubRevokedAt(page, "studio-mbp")).toBeNull();
  });

  test("cancel leaves the machine active", async ({ page }) => {
    await answerRevoke(page);
    await openLive(page, "/");
    await revokeButton(page, "studio-mbp").click();
    await dialog(page, "studio-mbp")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    const row = machineRow(page, "studio-mbp");
    await expect(row.getByText("Live", { exact: true })).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toBeVisible();
    await expectCount(page, "Agents", 3);
    // Nothing was sent. A DELETE is counted synchronously in the click that
    // sends it, and the dialog has closed since: there is nothing to wait for.
    expect(await deletesSent(page)).toBe(0);
    expect(await hubRevokedAt(page, "studio-mbp")).toBeNull();
  });

  test("a failed revoke shows inline in the open dialog and changes nothing", async ({
    page,
  }) => {
    await answerRevoke(page, {
      status: 500,
      code: "internal",
      message: "The hub is unavailable.",
    });
    await openLive(page, "/");
    await revokeButton(page, "studio-mbp").click();
    const dlg = dialog(page, "studio-mbp");
    await dlg.getByRole("button", { name: "Revoke machine" }).click();

    await expect(dlg.getByRole("alert")).toHaveText(
      "Couldn't revoke studio-mbp. The hub is unavailable.",
    );
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toHaveCount(0);
    const row = machineRow(page, "studio-mbp");
    await expect(row.getByText("Live", { exact: true })).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toBeVisible();
    await expectCount(page, "Agents", 3);
  });

  test("a revoke that fails after the dialog closed toasts the error and restores the row", async ({
    page,
  }) => {
    await answerRevoke(page, {
      status: 500,
      code: "internal",
      message: "The hub is unavailable.",
      gated: true,
    });
    await openLive(page, "/");
    await revokeButton(page, "studio-mbp").click();
    const dlg = dialog(page, "studio-mbp");
    await dlg.getByRole("button", { name: "Revoke machine" }).click();
    // Busy: the confirm reads "Revoking…" and both buttons are disabled.
    await expect(dlg.getByRole("button", { name: "Revoking…" })).toBeDisabled();
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // Escape closes a busy dialog; the request carries on.
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    // While pending the row already reads Revoked (the optimistic overlay).
    await expect(
      machineRow(page, "studio-mbp").getByText("Revoked", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      (window as unknown as { __obRelease(): void }).__obRelease(),
    );

    await expect(toastFor(page, "Couldn't revoke studio-mbp")).toBeVisible();
    await expect(
      machineRow(page, "studio-mbp").getByText("Live", { exact: true }),
    ).toBeVisible();
    await expect(revokeButton(page, "studio-mbp")).toBeVisible();
    await expectCount(page, "Agents", 3);
  });
});

test("a revoked machine is listed but has no actions", async ({ page }) => {
  await openLive(page, "/");
  const row = machineRow(page, "old-thinkpad");
  await expect(row.getByText("Revoked", { exact: true })).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("the revoke dialog is keyboard-operable and focus returns to its button", async ({
  page,
}) => {
  await openLive(page, "/");
  await revokeButton(page, "studio-mbp").focus();
  await page.keyboard.press("Enter");
  const dlg = dialog(page, "studio-mbp");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(revokeButton(page, "studio-mbp")).toBeFocused();
});

test("a load error says so and Retry recovers", async ({ page }) => {
  // GET /api/v1/machines fails (retries included) until `__obHeal` is set.
  await page.addInitScript(() => {
    const w = window as unknown as { __obHeal?: boolean; __obFails: number };
    w.__obFails = 0;
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const req = new Request(input, init);
      if (
        !w.__obHeal &&
        req.method === "GET" &&
        new URL(req.url).pathname === "/api/v1/machines"
      ) {
        w.__obFails++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "internal", message: "Boom" },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return real(input, init);
    };
  });
  // The stream's greeting would fill the list; block it so only Retry can recover.
  await streamHooks(page, { blocked: true });
  await page.goto("/");
  const alert = page.getByRole("alert").filter({
    hasText: "Couldn't load machines",
  });
  // The error shows only after the GET and both its retries (1 s, then 2 s
  // backoff) have failed: wait for that third failure, not a fixed timeout.
  await page.waitForFunction(
    () => (window as unknown as { __obFails: number }).__obFails >= 3,
  );
  await expect(alert).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __obHeal: boolean }).__obHeal = true;
  });
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(machineRow(page, "studio-mbp")).toBeVisible();
});
