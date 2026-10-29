// I11: server code knows the test key only as SERVER_TEST_CARD_KEY_X; nothing
// under src/ imports @ob/shared/mocks (it holds the private d, and msw).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
const files = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

describe("server code and the test card key", () => {
  it("never imports @ob/shared/mocks", () => {
    const bad = files(src).filter((f) =>
      /from\s+["']@ob\/shared\/mocks/.test(readFileSync(f, "utf8")),
    );
    expect(bad).toEqual([]);
  });
});
