import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requiredSecrets } from "../../../scripts/ops/check-staging-secrets.ts";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(server, p), "utf8");

describe("staging preflight (real files)", () => {
  it("needs no Worker secrets while the shell reads only vars", () => {
    expect(requiredSecrets(read("src/env.ts"), read("wrangler.jsonc"))).toEqual(
      [],
    );
  });
});
