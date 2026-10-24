// Captures the landing's images with Playwright (2x device pixels):
//   live  design/screens/live.html, light and dark, 1280x800 and 390x844, into
//         src/assets/shots (Astro turns them into webp) and design/landing/shots.
//   og    the built hero at 1200x630, demo on its last step, into public/og.png. Needs `pnpm preview`
//         running; pass its URL (default http://localhost:4321).
// Usage: node apps/landing/scripts/shots.mjs live|og [url]
import { copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const shots = resolve(here, "../src/assets/shots");
const mock = resolve(root, "design/landing/shots");

async function live(browser) {
  const page = pathToFileURL(resolve(root, "design/screens/live.html"));
  const sizes = {
    "": { width: 1280, height: 800 },
    "-phone": { width: 390, height: 844 },
  };
  for (const theme of ["light", "dark"]) {
    for (const [suffix, viewport] of Object.entries(sizes)) {
      const ctx = await browser.newContext({
        viewport,
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      const tab = await ctx.newPage();
      await tab.goto(`${page}?theme=${theme}`);
      await tab.addStyleTag({
        content: ".mockbar { display: none !important; }",
      });
      await tab.evaluate(() => document.fonts.ready);
      const file = `live${suffix}-${theme}.png`;
      await tab.screenshot({ path: resolve(shots, file) });
      copyFileSync(resolve(shots, file), resolve(mock, file));
      await ctx.close();
    }
  }
}

async function og(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 630 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const tab = await ctx.newPage();
  await tab.goto(url);
  await tab.evaluate(() => document.fonts.ready);
  // The demo's last step: both messages and both receipts shown.
  await tab.evaluate(() =>
    document
      .querySelector('[data-go="5"]')
      ?.dispatchEvent(new MouseEvent("click")),
  );
  await tab.screenshot({ path: resolve(here, "../public/og.png") });
  await ctx.close();
}

const [what, url = "http://localhost:4321"] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  if (what === "live") await live(browser);
  else if (what === "og") await og(browser, url);
  else throw new Error("usage: shots.mjs live|og [url]");
} finally {
  await browser.close();
}
