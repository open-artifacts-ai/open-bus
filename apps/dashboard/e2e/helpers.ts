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
) => expect(navLink(page, name)).toHaveAccessibleName(`${name}, ${n}`);

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

type Hooked = {
  __obRelease?: () => void;
  __obDeletes: number;
  __obFailedGets: number;
};

/**
 * Takes over machine DELETEs before the app boots (OA's pattern: page.route
 * can't see what MSW's service worker answers). Every DELETE is counted in
 * `__obDeletes`. Without `opts` it only counts and passes through.
 * - `status`/`code`/`message`: answer with that error envelope.
 * - `applyFirst`: the real (mock) revoke happens first, as when another tab
 *   won the race.
 * - `machinesOnly`: answer 204 after the hub marks only the machine revoked
 *   (`setMachines`) and leaves the agents alone, so only the client's
 *   `listedAgents` can take them off.
 * - `failRefetch`: after the DELETE, GET /api/v1/machines answers 500
 *   (counted in `__obFailedGets`).
 * - `gated`: hold the answer until `window.__obRelease()`.
 */
export const answerRevoke = (
  page: Page,
  opts: {
    status?: number;
    code?: string;
    message?: string;
    applyFirst?: boolean;
    machinesOnly?: boolean;
    failRefetch?: boolean;
    gated?: boolean;
  } = {},
) =>
  page.addInitScript((o) => {
    const w = window as unknown as Hooked;
    w.__obDeletes = 0;
    w.__obFailedGets = 0;
    const gate = new Promise<void>((r) => {
      w.__obRelease = r;
    });
    const envelope = (status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    const real = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const req = new Request(input, init);
      const path = new URL(req.url).pathname;
      if (
        o.failRefetch &&
        w.__obDeletes > 0 &&
        req.method === "GET" &&
        path === "/api/v1/machines"
      ) {
        w.__obFailedGets++;
        return envelope(500, "internal", "Boom");
      }
      if (req.method !== "DELETE" || !path.startsWith("/api/v1/machines/"))
        return real(input, init);
      w.__obDeletes++;
      if (o.gated) await gate;
      if (o.machinesOnly) {
        const bus = window.__obMock;
        const id = decodeURIComponent(path.split("/").pop() ?? "");
        if (!bus) throw new Error("no mock bus");
        bus.setMachines(
          bus.machines().map((m) =>
            m.id === id
              ? {
                  ...m,
                  revokedAt: new Date().toISOString(),
                  connected: false,
                }
              : m,
          ),
        );
        return new Response(null, { status: 204 });
      }
      if (o.status === undefined) return real(input, init);
      if (o.applyFirst) await real(input, init);
      return envelope(o.status, o.code ?? "internal", o.message ?? "");
    };
  }, opts);

/** How many machine DELETEs the page sent (needs `answerRevoke`). */
export const deletesSent = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooked).__obDeletes);

/** The mock hub's revokedAt for a machine, by label. */
export const hubRevokedAt = (page: Page, label: string) =>
  page.evaluate((l) => {
    const m = window.__obMock?.machines().find((x) => x.label === l);
    if (!m) throw new Error(`no machine ${l} in the mock hub`);
    return m.revokedAt;
  }, label);

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
