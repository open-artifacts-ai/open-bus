import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newMachineToken } from "@ob/shared";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, START_ERROR_CODES, StartError } from "../src/config.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

const prev = { home: process.env.OPENBUS_HOME, hub: process.env.OPENBUS_HUB };
afterEach(async () => {
  for (const [k, v] of [
    ["OPENBUS_HOME", prev.home],
    ["OPENBUS_HUB", prev.hub],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await stopAll();
});

/** readConfig on a temp home holding `json` (or no machine.json) at `mode`. */
function codeOf(json?: unknown, mode = 0o600): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "ob-start-"));
  if (json !== undefined) {
    writeFileSync(join(dir, "machine.json"), JSON.stringify(json));
    chmodSync(join(dir, "machine.json"), mode);
  }
  process.env.OPENBUS_HOME = dir;
  try {
    readConfig();
  } catch (e) {
    expect(e).toBeInstanceOf(StartError);
    return (e as StartError).code;
  }
  return undefined;
}

const ok = { hub: "wss://bus.example.com", machine_token: newMachineToken() };

describe("lasting start failures carry a stable code", () => {
  it("readConfig: each refusal has its code", () => {
    expect(codeOf()).toBe("NOT_LOGGED_IN");
    expect(codeOf({ hub: ok.hub })).toBe("NOT_LOGGED_IN");
    expect(codeOf({ ...ok, machine_token: "nope" })).toBe("NOT_LOGGED_IN");
    expect(codeOf(ok, 0o644)).toBe("CREDENTIALS_OPEN");
    expect(codeOf({ ...ok, hub: "ws://bus.example.com" })).toBe("BAD_HUB");
    process.env.OPENBUS_HUB = "wss://other.example.com";
    expect(codeOf(ok)).toBe("HUB_MISMATCH");
    delete process.env.OPENBUS_HUB;
    expect(codeOf(ok)).toBeUndefined();
  });

  it("runDaemon: a socket another daemon answers on is SOCKET_IN_USE", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ob-sock-")), "d.sock");
    const other = createServer();
    await new Promise<void>((r) => other.listen(path, r));
    try {
      await expect(daemonHarness({ socketPath: path })).rejects.toMatchObject({
        code: "SOCKET_IN_USE",
      });
    } finally {
      other.close();
    }
  });

  it("the codes are the documented set", () => {
    expect(START_ERROR_CODES).toEqual([
      "NOT_LOGGED_IN",
      "HUB_MISMATCH",
      "BAD_HUB",
      "CREDENTIALS_OPEN",
      "SOCKET_IN_USE",
    ]);
  });
});
