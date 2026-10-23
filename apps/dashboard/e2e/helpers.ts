import { createRequire } from "node:module";
import { expect, type Page } from "@playwright/test";

/** axe-core comes from @ob/ui, as in OA's dashboard e2e. */
export const AXE = createRequire(import.meta.url).resolve(
  "axe-core/axe.min.js",
  {
    paths: [new URL("../../../packages/ui", import.meta.url).pathname],
  },
);

/** One machine's row in the Machines table. */
export const machineRow = (page: Page, label: string) =>
  page.getByRole("row").filter({ hasText: label });

/** The sidebar link; its name carries the count ("Agents, 3"). */
export const navLink = (page: Page, name: "Machines" | "Agents") =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", {
    name: new RegExp(`^${name}\\b`),
  });

/** The nav link's name ends in its count ("Agents, 3"). */
export const expectCount = (
  page: Page,
  name: "Machines" | "Agents",
  n: number,
) =>
  expect(navLink(page, name)).toHaveAccessibleName(
    new RegExp(`^${name}\\s*,\\s*${n}$`),
  );

/**
 * Loads a route and waits until the app's stream has had its hello, so a
 * frame pushed through `window.__obMock` reaches the page.
 */
export async function openLive(page: Page, path: string) {
  await streamHooks(page);
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForFunction(
    () => ((window as unknown as { __obHellos?: number }).__obHellos ?? 0) > 0,
  );
}

/**
 * Answers the next machine DELETE with `status` and an error envelope, before
 * the app boots (OA's pattern: page.route can't see what MSW's service worker
 * answers). `applyFirst` lets the real (mock) revoke happen first, as when
 * another tab won the race. `gated` holds the answer until
 * `window.__obRelease()` is called.
 */
export const answerRevoke = (
  page: Page,
  opts: {
    status: number;
    code: string;
    message: string;
    applyFirst?: boolean;
    gated?: boolean;
  },
) =>
  page.addInitScript((o) => {
    const w = window as unknown as { __obRelease?: () => void };
    const gate = new Promise<void>((r) => {
      w.__obRelease = r;
    });
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const req = new Request(input, init);
      if (
        req.method !== "DELETE" ||
        !new URL(req.url).pathname.startsWith("/api/v1/machines/")
      )
        return real(input, init);
      if (o.applyFirst) await real(input, init);
      if (o.gated) await gate;
      return new Response(
        JSON.stringify({ error: { code: o.code, message: o.message } }),
        {
          status: o.status,
          headers: { "content-type": "application/json" },
        },
      );
    };
  }, opts);

/** document.scrollingElement wider than the viewport, with the culprits. */
export async function sidewaysOverflow(page: Page) {
  return page.evaluate(() => {
    const se = document.scrollingElement as Element;
    const wide = [...document.querySelectorAll("body *")]
      .filter((e) => e.getBoundingClientRect().right > innerWidth + 1)
      .map(
        (e) =>
          `${e.tagName.toLowerCase()}.${(e.getAttribute("class") ?? "").split(" ")[0]} right=${Math.round(e.getBoundingClientRect().right)}`,
      )
      .slice(0, 6);
    return { sw: se.scrollWidth, iw: innerWidth, wide };
  });
}

/**
 * Wraps EventSource before the app boots. It counts hellos (`__obHellos`)
 * and, while `__obBlockStream` is true, swaps the URL for one Vite answers
 * with HTML, so the stream fails before its hello and parks (paused) until
 * Retry, the way a connection that can't come back does.
 */
export const streamHooks = (page: Page, { blocked = false } = {}) =>
  page.addInitScript((b) => {
    const w = window as unknown as {
      __obBlockStream: boolean;
      __obHellos: number;
      EventSource: typeof EventSource;
    };
    w.__obBlockStream = b;
    w.__obHellos = 0;
    const Real = window.EventSource;
    w.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(w.__obBlockStream ? "/__ob_blocked_stream" : url, init);
        this.addEventListener("message", (m) => {
          if (typeof m.data === "string" && m.data.includes('"hello"'))
            w.__obHellos++;
        });
      }
    };
  }, blocked);
