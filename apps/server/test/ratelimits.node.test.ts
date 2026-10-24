import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../../scripts/setup/src/jsonc.ts";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = parseJsonc(
  readFileSync(join(server, "wrangler.jsonc"), "utf8"),
) as { ratelimits?: { name: string; namespace_id: string; simple: unknown }[] };

describe("staging rate-limit bindings (real wrangler.jsonc)", () => {
  it("binds RL_AUTH and RL_DEVICE at 20 per 60 s on distinct namespaces", () => {
    const rl = cfg.ratelimits ?? [];
    expect(rl.map((r) => r.name).sort()).toEqual(["RL_AUTH", "RL_DEVICE"]);
    for (const r of rl) expect(r.simple).toEqual({ limit: 20, period: 60 });
    expect(new Set(rl.map((r) => r.namespace_id)).size).toBe(2);
  });
});
