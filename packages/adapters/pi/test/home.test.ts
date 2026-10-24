import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socketPath } from "../assets/openbus.ts";

afterEach(() => vi.unstubAllEnvs());

describe("pi extension daemon socket", () => {
  it("treats an empty OPENBUS_HOME as unset: ~/.openbus, never the cwd", () => {
    vi.stubEnv("OPENBUS_HOME", "");
    expect(socketPath()).toBe(join(homedir(), ".openbus", "daemon.sock"));
  });
});
