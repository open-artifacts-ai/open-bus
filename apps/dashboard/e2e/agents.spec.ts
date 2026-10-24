// The Agents roster (Design D5): one namespace at a time, global agents only
// in their own section, a Live/Queued filter, live pushes without a reload,
// and a paused stream that keeps the rows. Fixtures: @ob/shared/mocks
// (github.com/acme/app: claude-1 live on studio-mbp, opencode-1 queued on
// laptop; scout, global, live on studio-mbp).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { expectCount, openLive, streamHooks } from "./helpers";

const APP = "github.com/acme/app";
const nsTable = (page: Page) =>
  page.getByRole("table", { name: "Agents in this namespace" });
const globalTable = (page: Page) =>
  page.getByRole("table", { name: "Agents every namespace sees" });
const chips = (page: Page) =>
  page.getByRole("radiogroup", { name: "Namespaces" });
const filter = (page: Page) => page.getByRole("radiogroup", { name: "Filter" });
const bodyRows = (table: ReturnType<typeof nsTable>) =>
  table.locator("tbody").getByRole("row");

/** The fixtures plus `extra`, through the bus as the hub would announce them. */
const setRoster = (page: Page, extra: Record<string, unknown>[]) =>
  page.evaluate((more) => {
    const bus = window.__obMock;
    if (!bus) throw new Error("no mock bus");
    bus.setAgents([...bus.agents(), ...more]);
  }, extra);

const agent = (over: Record<string, unknown>) => ({
  id: "Zz9Zz9Zz9Zz9Zz9Z",
  namespace: APP,
  name: "claude-2",
  kind: "claude-code",
  machineId: "gBU34nzaAXEesQMc",
  machineLabel: "laptop",
  global: false,
  state: "live",
  updatedAt: new Date().toISOString(),
  ...over,
});

test("agents are grouped by namespace; global agents show only in their own section", async ({
  page,
}) => {
  await openLive(page, "/agents");
  await expect(
    chips(page).getByRole("radio", { name: /^github\.com\/acme\/app/ }),
  ).toHaveAttribute("aria-checked", "true");
  const ns = nsTable(page);
  await expect(bodyRows(ns)).toHaveCount(2);
  await expect(
    ns.getByRole("img", { name: "claude-1 on studio-mbp is live" }),
  ).toBeVisible();
  await expect(
    ns.getByRole("img", { name: "opencode-1 on laptop is queued" }),
  ).toBeVisible();
  // Live first, then queued.
  await expect(bodyRows(ns).first()).toContainText("claude-1");
  await expect(ns.getByText("scout")).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: "Global agents" }),
  ).toBeVisible();
  const g = globalTable(page);
  await expect(bodyRows(g)).toHaveCount(1);
  await expect(g.getByText("global", { exact: true })).toBeVisible();
  await expect(
    g.getByRole("img", { name: "scout on studio-mbp is live" }),
  ).toBeVisible();
  // Its home namespace is never shown.
  await expect(page.getByText("github.com/acme/docs")).toHaveCount(0);
  await expect(
    page.getByText(/2 agents in\s+github\.com\/acme\/app · 1 live/),
  ).toBeVisible();

  // The global chip shows only the Global agents section.
  await chips(page)
    .getByRole("radio", { name: /^global/ })
    .click();
  await expect(nsTable(page)).toHaveCount(0);
  await expect(bodyRows(globalTable(page))).toHaveCount(1);
  await expect(page.getByText(/1 global agent · 1 live/)).toBeVisible();
});

test("the Live and Queued filters narrow both tables", async ({ page }) => {
  await openLive(page, "/agents");
  await filter(page).getByRole("radio", { name: "Live" }).click();
  await expect(bodyRows(nsTable(page))).toHaveCount(1);
  await expect(nsTable(page)).toContainText("claude-1");
  await expect(bodyRows(globalTable(page))).toHaveCount(1);
  await expect(page.getByText(/1 of 2 agents in/)).toBeVisible();

  await filter(page).getByRole("radio", { name: "Queued" }).click();
  await expect(bodyRows(nsTable(page))).toHaveCount(1);
  await expect(nsTable(page)).toContainText("opencode-1");
  await expect(globalTable(page)).toContainText("No agents match this filter.");

  await filter(page).getByRole("radio", { name: "All" }).click();
  await expect(bodyRows(nsTable(page))).toHaveCount(2);
});

test("a pushed roster frame updates the page without a reload", async ({
  page,
}) => {
  await openLive(page, "/agents");
  await page.evaluate(() => {
    (window as unknown as { __obSamePage: boolean }).__obSamePage = true;
  });
  await expectCount(page, "Agents", 3);
  await setRoster(page, [agent({})]);

  await expect(
    nsTable(page).getByRole("img", { name: "claude-2 on laptop is live" }),
  ).toBeVisible();
  await expect(bodyRows(nsTable(page))).toHaveCount(3);
  await expectCount(page, "Agents", 4);
  // Same document: no navigation happened.
  expect(
    await page.evaluate(
      () => (window as unknown as { __obSamePage?: boolean }).__obSamePage,
    ),
  ).toBe(true);
});

test("a machine leaving takes its agents with it", async ({ page }) => {
  await openLive(page, "/agents");
  await expect(nsTable(page)).toContainText("claude-1");
  await page.evaluate(() => {
    const bus = window.__obMock;
    if (bus)
      bus.setAgents(
        bus.agents().filter((a) => a.machineLabel !== "studio-mbp"),
      );
  });
  await expect(page.getByText("claude-1")).toHaveCount(0);
  await expect(page.getByText("scout")).toHaveCount(0);
  await expect(bodyRows(nsTable(page))).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Global agents" }),
  ).toHaveCount(0);
  await expectCount(page, "Agents", 1);
});

test("an empty roster says so", async ({ page }) => {
  await openLive(page, "/agents");
  await page.evaluate(() => window.__obMock?.setAgents([]));
  await expect(
    page.getByRole("heading", { name: "No agents in this namespace" }),
  ).toBeVisible();
  await expect(page.getByText("No agents", { exact: true })).toBeVisible();
  await expectCount(page, "Agents", 0);
});

test("a namespace view never shows another namespace's agents (Verification 6)", async ({
  page,
}) => {
  await openLive(page, "/agents");
  await setRoster(page, [
    agent({
      id: "Yy8Yy8Yy8Yy8Yy8Y",
      namespace: "github.com/acme/api",
      name: "api-bot",
    }),
  ]);
  const api = chips(page).getByRole("radio", {
    name: /^github\.com\/acme\/api/,
  });
  await expect(api).toBeVisible();

  // The namespace with the most agents (app, 2) is the default view (D5).
  const app = chips(page).getByRole("radio", {
    name: /^github\.com\/acme\/app/,
  });
  await expect(app).toHaveAttribute("aria-checked", "true");
  await expect(nsTable(page)).toContainText("claude-1");
  await expect(page.getByText("api-bot")).toHaveCount(0);
  await expect(globalTable(page)).toContainText("scout");

  await api.click();
  await expect(nsTable(page)).toContainText("api-bot");
  await expect(page.getByText("claude-1")).toHaveCount(0);
  await expect(page.getByText("opencode-1")).toHaveCount(0);
  await expect(globalTable(page)).toContainText("scout");
});

test("a paused stream keeps the rows, says when they were current, and Retry resumes", async ({
  page,
}) => {
  await streamHooks(page, { blocked: true });
  await page.goto("/agents");
  const banner = page
    .getByRole("status")
    .filter({ hasText: "Live updates paused." });
  await expect(banner).toHaveText(
    /^Live updates paused\. Showing the roster as of \d{1,2}:\d{2}\s?[AP]M\.$/,
  );
  // Retry sits outside the live region, so it isn't re-announced.
  await expect(banner.getByRole("button")).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  // The rows stay; their labels say how old the claim is.
  await expect(
    nsTable(page).getByRole("img", {
      name: /^claude-1 on studio-mbp, live as of \d{1,2}:\d{2}\s?[AP]M$/,
    }),
  ).toBeVisible();
  await expect(
    nsTable(page).getByRole("img", { name: /^claude-1 on studio-mbp, live/ }),
  ).toHaveAttribute("data-muted", "true");

  await page.evaluate(() => {
    (window as unknown as { __obBlockStream: boolean }).__obBlockStream = false;
  });
  await retry.click();
  await expect(banner).toHaveCount(0);
  await expect(retry).toHaveCount(0);
  await expect(
    nsTable(page).getByRole("img", { name: "claude-1 on studio-mbp is live" }),
  ).toBeVisible();
  // Live again: a push lands.
  await page.waitForFunction(
    () => ((window as unknown as { __obHellos?: number }).__obHellos ?? 0) > 0,
  );
  await setRoster(page, [agent({})]);
  await expect(nsTable(page)).toContainText("claude-2");
});

test("the roster fits a 375 px phone without sideways scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openLive(page, "/agents");
  await expect(nsTable(page)).toContainText("claude-1");
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});
