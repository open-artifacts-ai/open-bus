import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = `${import.meta.dirname}/../src/shadcn/ui`;
const OVERLAYS = ["alert-dialog", "dialog", "sheet"];

// Overlay backdrops use the --ob-scrim token, not a hard-coded black.
describe("overlay scrim", () => {
  for (const name of OVERLAYS) {
    it(`${name} backdrop uses --ob-scrim`, () => {
      const src = readFileSync(`${dir}/${name}.tsx`, "utf8");
      const overlay = src.match(/"fixed inset-0 z-50[^"]*"/g) ?? [];
      expect(overlay.length).toBeGreaterThan(0);
      for (const cls of overlay) {
        expect(cls).toContain("bg-(--ob-scrim)");
        expect(cls).not.toContain("bg-black");
      }
    });
  }
});
