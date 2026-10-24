import { daemonStatus } from "@ob/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

describe("daemon status", () => {
  it("reports its pid, label, hub link and this namespace's open agents", async () => {
    const h = await daemonHarness({
      claude: { syncMs: 3_600_000 },
      version: "9.9.9",
      resolveNamespace: (cwd) => ({
        namespace: cwd === "/elsewhere" ? "other" : "ns",
        global: false,
        source: "cwd",
      }),
    });
    await h.adapter("ses_a", { kind: "pi", proposed_name: "alpha" });
    const st = await daemonStatus({ path: h.socketPath, cwd: "/w" });
    expect(st).toMatchObject({
      pid: process.pid,
      version: "9.9.9",
      label: "laptop",
      hub: "connected",
      namespace: "ns",
      agents: [{ name: "alpha", kind: "pi", live: true }],
    });
    const other = await daemonStatus({ path: h.socketPath, cwd: "/elsewhere" });
    expect(other).toMatchObject({ namespace: "other", agents: [] });
  });
});
