// AC4a: the Worker bundle never carries the private test card key.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_CARD_JWK, TEST_CARD_KEY_X } from "@ob/shared/mocks";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the Worker bundle", () => {
  it("knows the test key's x but never its d", async () => {
    const r = await build({
      entryPoints: [join(server, "src/index.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "browser"],
      mainFields: ["module", "main"],
      external: ["cloudflare:*", "node:*"],
      logLevel: "silent",
    });
    const text = r.outputFiles[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(10_000);
    expect(text).toContain(TEST_CARD_KEY_X);
    expect(text).not.toContain(TEST_CARD_JWK.d);
    expect(text).not.toContain("TEST_CARD_JWK");
  });
});
