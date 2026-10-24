import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTALL_RATELIMITS, renderConfig } from "../src/steps/deploy.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const real = readFileSync(join(repo, "apps/server/wrangler.jsonc"), "utf8");
type Rl = { name: string; namespace_id: string; simple: unknown };
const rendered = (text = real) =>
  JSON.parse(
    renderConfig(text, "/srv", "open-bus-prod", "bus.example.com"),
  ) as {
    ratelimits?: Rl[];
  };

describe("renderConfig rate limits", () => {
  it("gives installs their own namespaces, never staging's (I9: prod gets 3001/3002)", () => {
    const rl = rendered().ratelimits ?? [];
    expect(Object.fromEntries(rl.map((r) => [r.name, r.namespace_id]))).toEqual(
      {
        RL_DEVICE: "3001",
        RL_AUTH: "3002",
      },
    );
    for (const r of rl) expect(r.simple).toEqual({ limit: 20, period: 60 });
    expect(INSTALL_RATELIMITS.map((r) => r.namespace_id)).toEqual([
      "3001",
      "3002",
    ]);
  });

  it("binds them even when the source config has none", () => {
    expect(
      rendered('{ "name": "x", "main": "src/index.ts" }').ratelimits,
    ).toEqual(INSTALL_RATELIMITS);
  });
});
