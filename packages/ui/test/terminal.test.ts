import { describe, expect, it } from "vitest";
import { terminal, terminalAnsi } from "../src/tokens/terminal";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(["light", "dark"] as const)("%s terminal theme", (theme) => {
  const bg = terminal.bg?.[theme] as string;

  it("uses hex colors", () => {
    for (const [key, pair] of Object.entries(terminal))
      for (const t of ["light", "dark"] as const)
        expect(pair[t], key).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(["ink", "muted", "accent", "success", "warning", "danger"])(
    "%s is at least 4.5:1 on bg",
    (key) => {
      expect(
        contrast(terminal[key]?.[theme] as string, bg),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("hairline is at least 1.5:1 on bg", () => {
    expect(
      contrast(terminal.hairline?.[theme] as string, bg),
    ).toBeGreaterThanOrEqual(1.5);
  });
});

describe("ANSI fallback", () => {
  it("maps only palette colors to 16-color slots", () => {
    for (const key of Object.keys(terminalAnsi))
      expect(Object.keys(terminal)).toContain(key);
    for (const pair of Object.values(terminalAnsi))
      for (const t of ["light", "dark"] as const) {
        expect(Number.isInteger(pair[t])).toBe(true);
        expect(pair[t]).toBeGreaterThanOrEqual(0);
        expect(pair[t]).toBeLessThanOrEqual(15);
      }
  });

  it("uses the bright slots on dark", () => {
    for (const pair of Object.values(terminalAnsi))
      expect(pair.dark).toBeGreaterThan(7);
  });
});
