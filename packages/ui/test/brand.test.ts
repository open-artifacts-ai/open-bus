import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url));

// Rendered by `node apps/landing/scripts/shots.mjs favicons` from favicon.svg.
const files = [
  "favicon.svg",
  "favicon.ico",
  "favicon-16.png",
  "favicon-32.png",
  "favicon-512.png",
  "apple-touch-icon.png",
];

describe.each(["apps/landing/public", "apps/dashboard/public"])(
  "%s serves the @ob/ui favicon set",
  (dir) => {
    it.each(files)("%s is a copy of packages/ui/src/brand", (file) => {
      expect(read(`${dir}/${file}`).equals(read(`packages/ui/src/brand/${file}`))).toBe(true);
    });
  },
);

describe("the favicon follows the theme on its own", () => {
  const svg = read("packages/ui/src/brand/favicon.svg").toString();
  it("has dark values under prefers-color-scheme and no external reference", () => {
    expect(svg).toContain("prefers-color-scheme:dark");
    expect(svg).not.toMatch(/href=|url\(|@import|var\(/);
  });
});
