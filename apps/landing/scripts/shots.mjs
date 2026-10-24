// Captures the landing's images with Playwright (2x device pixels):
//   live  design/screens/live.html, light and dark, 1280x800 and 390x844, into
//         src/assets/shots (Astro turns them into webp) and design/landing/shots.
//   og    the built hero at 1200x630, demo on its last step, into public/og.png. Needs `pnpm preview`
//         running; pass its URL (default http://localhost:4321).
//   favicons  packages/ui/src/brand/favicon.svg (light values) as PNGs: 16, 32 and 512 on
//         transparent, the 180 apple-touch icon on --ob-bg (iOS ignores transparency), and
//         favicon.ico (the 16 and 32 PNGs). Written to packages/ui/src/brand and copied,
//         with favicon.svg, into the landing's and the dashboard's public/ (not the 512,
//         until a web manifest links it).
// Usage: node apps/landing/scripts/shots.mjs live|og|favicons [url]
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
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

async function favicons(browser) {
  const brand = resolve(root, "packages/ui/src/brand");
  const svg = readFileSync(resolve(brand, "favicon.svg"), "utf8");
  const ctx = await browser.newContext({ colorScheme: "light" });
  const tab = await ctx.newPage();
  const shoot = async (size, file, bg) => {
    // The touch icon gets a margin so the rings clear iOS's rounded corners.
    const pad = bg ? Math.round(size * 0.14) : 0;
    await tab.setViewportSize({ width: size, height: size });
    await tab.setContent(
      `<html><body style="margin:0;background:${bg ?? "transparent"}"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="display:block;box-sizing:border-box;width:${size}px;height:${size}px;padding:${pad}px"></body></html>`,
    );
    await tab.screenshot({ path: resolve(brand, file), omitBackground: !bg });
  };
  await shoot(16, "favicon-16.png");
  await shoot(32, "favicon-32.png");
  await shoot(512, "favicon-512.png");
  await shoot(180, "apple-touch-icon.png", "#eef0f3");
  await ctx.close();
  writeFileSync(resolve(brand, "favicon.ico"), ico(brand, [16, 32]));
  const files = [
    "favicon.svg",
    "favicon.ico",
    "favicon-16.png",
    "favicon-32.png",
    "apple-touch-icon.png",
  ];
  for (const app of ["apps/landing/public", "apps/dashboard/public"]) {
    for (const f of files)
      copyFileSync(resolve(brand, f), resolve(root, app, f));
  }
}

/** An .ico holding PNG images (valid since Windows Vista; every browser reads it). */
function ico(dir, sizes) {
  const pngs = sizes.map((s) => readFileSync(resolve(dir, `favicon-${s}.png`)));
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const at = 6 + 16 * i;
    head.writeUInt8(sizes[i] % 256, at);
    head.writeUInt8(sizes[i] % 256, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs]);
}

const [what, url = "http://localhost:4321"] = process.argv.slice(2);
const browser = await chromium.launch();
try {
  if (what === "live") await live(browser);
  else if (what === "og") await og(browser, url);
  else if (what === "favicons") await favicons(browser);
  else throw new Error("usage: shots.mjs live|og|favicons [url]");
} finally {
  await browser.close();
}
