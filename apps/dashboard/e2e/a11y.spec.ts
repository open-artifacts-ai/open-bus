// OA's m2-a11y shape: axe (serious and critical) on every screen, light and
// dark, at 1280 and 390, plus no sideways scroll at 390.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { AXE, openLive, sidewaysOverflow, streamHooks } from "./helpers";

/** Signed out: GET /api/v1/me answers 401, as the Worker does without a session. */
const signedOut = (page: Page) =>
  page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (new URL(new Request(input, init).url).pathname === "/api/v1/me")
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

type Screen = {
  name: string;
  path: string;
  setup?: (p: Page) => Promise<unknown>;
  /** Waits for the screen to be what it claims (after the h1 is up). */
  ready: (p: Page) => Promise<unknown>;
};

const SCREENS: Screen[] = [
  {
    name: "machines",
    path: "/",
    ready: (p) =>
      expect(
        p.getByRole("row").filter({ hasText: "studio-mbp" }),
      ).toBeVisible(),
  },
  {
    name: "revoke dialog",
    path: "/",
    ready: async (p) => {
      await p.getByRole("button", { name: "Revoke studio-mbp" }).click();
      await expect(p.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "agents",
    path: "/agents",
    ready: (p) =>
      expect(p.getByRole("heading", { name: "Global agents" })).toBeVisible(),
  },
  {
    name: "agents paused",
    path: "/agents",
    setup: (p) => streamHooks(p, { blocked: true }),
    ready: (p) =>
      expect(
        p.getByText("Live updates paused.", { exact: false }),
      ).toBeVisible(),
  },
  {
    name: "not found",
    path: "/nope",
    ready: (p) =>
      expect(p.getByRole("link", { name: "Back to machines" })).toBeVisible(),
  },
  {
    name: "sign-in",
    path: "/sign-in",
    setup: signedOut,
    ready: (p) =>
      expect(
        p.getByRole("link", { name: "Continue with Cloudflare Access" }),
      ).toBeVisible(),
  },
  {
    name: "sign-in failed",
    path: "/sign-in?error=1",
    setup: signedOut,
    ready: (p) =>
      expect(p.getByRole("alert")).toHaveText(
        "Sign-in didn't finish. Try again.",
      ),
  },
];

/**
 * Waits until every CSS transition and animation has finished: axe measuring
 * mid-transition reads blended colors and fails contrast (OA's `settled`).
 */
const settled = (page: Page) =>
  page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== "running"),
  );

const open = async (page: Page, s: Screen, theme: string, w: number) => {
  await page.setViewportSize({ width: w, height: 800 });
  await page.emulateMedia({ colorScheme: theme as "light" | "dark" });
  await s.setup?.(page);
  if (s.setup) await page.goto(s.path);
  else await openLive(page, s.path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await s.ready(page);
  // Both routes the theme follows: the OS preference above and <html data-theme>.
  await page.evaluate(
    (t) => document.documentElement.setAttribute("data-theme", t),
    theme,
  );
  await settled(page);
};

for (const s of SCREENS)
  for (const theme of ["light", "dark"])
    for (const w of [1280, 390])
      test(`axe ${s.name} ${theme} ${w}`, async ({ page }) => {
        await open(page, s, theme, w);
        await page.addScriptTag({ path: AXE });
        const v = await page.evaluate(async () => {
          // @ts-expect-error injected
          const res = await axe.run(document, { resultTypes: ["violations"] });
          return res.violations
            .filter(
              (x: { impact: string }) =>
                x.impact === "serious" || x.impact === "critical",
            )
            .map(
              (x: {
                id: string;
                impact: string;
                nodes: { target: string[] }[];
              }) =>
                `${x.impact} ${x.id}: ${x.nodes
                  .map((n) => n.target.join(" "))
                  .slice(0, 4)
                  .join(" | ")}`,
            );
        });
        expect(v, v.join("\n")).toEqual([]);
      });

for (const s of SCREENS)
  test(`no horizontal scroll at 390: ${s.name}`, async ({ page }) => {
    await open(page, s, "light", 390);
    const res = await sidewaysOverflow(page);
    expect(
      res.sw,
      `${res.sw} > ${res.iw}; ${res.wide.join(", ")}`,
    ).toBeLessThanOrEqual(res.iw);
  });
