import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokens } from "../src/index";

const css = readFileSync(
  new URL("../src/tokens/tokens.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of the first rule whose prelude matches `prelude`. */
function block(prelude: string): Map<string, string> {
  const at = css.indexOf(prelude);
  expect(at, prelude).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  let depth = 1;
  let i = open + 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    i++;
  }
  const props = new Map<string, string>();
  for (const [, name, value] of css
    .slice(open + 1, i - 1)
    .matchAll(/--ob-([\w-]+)\s*:\s*([^;]+);/g)) {
    expect(props.has(`--ob-${name}`), `duplicate --ob-${name}`).toBe(false);
    props.set(name as string, (value as string).trim().toLowerCase());
  }
  return props;
}

const light = block(":root {");
const dark = block(':root[data-theme="dark"] {');

describe("tokens.css mirrors tokens", () => {
  it("defines every exported token in :root", () => {
    expect([...light.keys()]).toEqual(
      expect.arrayContaining(Object.keys(tokens)),
    );
  });

  it.each(Object.keys(tokens))("%s matches in light and dark", (key) => {
    expect(light.get(key)).toBe(tokens[key]?.light.toLowerCase());
    expect(dark.get(key)).toBe(tokens[key]?.dark.toLowerCase());
  });

  it("keeps the dark media block identical to the dark attribute block", () => {
    const media = block(':root:not([data-theme="light"]) {');
    expect([...media.entries()].sort()).toEqual([...dark.entries()].sort());
  });
});

describe("tokens.css is offline", () => {
  it("has no @import and no http", () => {
    const raw = readFileSync(
      new URL("../src/tokens/tokens.css", import.meta.url),
      "utf8",
    );
    expect(raw).not.toContain("@import");
    expect(raw).not.toContain("http");
  });
});
