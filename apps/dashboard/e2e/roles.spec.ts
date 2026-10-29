// Roles (AC6.3): add a role pointed at an open agent, re-point it, remove it,
// the server's 409 on the name field. Fixtures: lane-6 -> claude-1 (live),
// reviewer vacant; opencode-1 is queued and holds nothing.
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { openLive } from "./helpers";

const rolesTable = (page: Page) =>
  page.getByRole("table", { name: "Roles and the agents they point at" });
const roleRow = (page: Page, name: string) =>
  rolesTable(page).getByRole("row").filter({ hasText: name });

/** Picks a holder in the open dialog's Holder select. */
const pickHolder = async (page: Page, name: RegExp) => {
  await page.getByRole("combobox", { name: "Holder" }).click();
  await page.getByRole("option", { name }).click();
};

test("add a role pointed at an open agent", async ({ page }) => {
  await openLive(page, "/roles");
  await expect(roleRow(page, "lane-6")).toBeVisible();
  await page.getByRole("button", { name: "Add role" }).click();
  const dlg = page.getByRole("dialog", { name: "Add role" });
  await dlg.getByLabel("Role name").fill("lead");
  await pickHolder(page, /opencode-1/);
  await dlg.getByRole("button", { name: "Save role" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(roleRow(page, "lead")).toContainText("opencode-1");
});

test("a role equal to an open agent's name shows the 409 on the name field", async ({
  page,
}) => {
  await openLive(page, "/roles");
  await page.getByRole("button", { name: "Add role" }).click();
  const dlg = page.getByRole("dialog", { name: "Add role" });
  await dlg.getByLabel("Role name").fill("opencode-1");
  await pickHolder(page, /opencode-1/);
  await dlg.getByRole("button", { name: "Save role" }).click();
  const field = dlg.getByLabel("Role name");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(dlg).toContainText("is already an open agent's name");
  await expect(dlg).toBeVisible();
});

test("re-point a role to another agent", async ({ page }) => {
  await openLive(page, "/roles");
  await expect(roleRow(page, "lane-6")).toContainText("claude-1");
  await page.getByRole("button", { name: "Re-point lane-6" }).click();
  const dlg = page.getByRole("dialog", { name: "Re-point lane-6" });
  await pickHolder(page, /opencode-1/);
  await dlg.getByRole("button", { name: "Save role" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(roleRow(page, "lane-6")).toContainText("opencode-1");
});

test("remove a role with confirm", async ({ page }) => {
  await openLive(page, "/roles");
  await page.getByRole("button", { name: "Remove reviewer" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toContainText("Remove reviewer?");
  await dlg.getByRole("button", { name: "Remove role" }).click();
  await expect(roleRow(page, "reviewer")).toHaveCount(0);
  await expect(roleRow(page, "lane-6")).toBeVisible();
});
