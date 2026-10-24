import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { home, socketPath } from "../src/config.ts";
import { realCtx } from "../src/context.ts";

afterEach(() => vi.unstubAllEnvs());

describe("cli OPENBUS_HOME", () => {
  it("treats an empty OPENBUS_HOME as unset: ~/.openbus, never the cwd", () => {
    vi.stubEnv("OPENBUS_HOME", "");
    const def = join(homedir(), ".openbus");
    expect(home()).toBe(def);
    expect(socketPath()).toBe(
      join(realpathSync.native(homedir()), ".openbus", "daemon.sock"),
    );
    expect(realCtx(true).home).toBe(def);
  });
});
