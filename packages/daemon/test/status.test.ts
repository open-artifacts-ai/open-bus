import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonStatus } from "@ob/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubConnection } from "../src/hub.ts";
import { daemonHarness, opts, stopAll } from "./helpers.ts";

afterEach(stopAll);

const resolveNamespace = (cwd: string) => ({
  namespace: cwd.startsWith("/notes") ? "notes" : "ns",
  global: false,
  source: "cwd" as const,
});
const row = (
  bus_name: string,
  kind: string,
  namespace: string,
  state: string,
) => ({
  bus_name,
  kind,
  namespace,
  global: false,
  state,
});

describe("daemon status", () => {
  it("one roster per namespace, from the hub, with this machine's label on its own rows", async () => {
    const h = await daemonHarness({
      claude: { syncMs: 3_600_000 },
      version: "9.9.9",
      resolveNamespace,
    });
    // The stub hub answers list with the namespace's roster across machines.
    h.hubSock()?.on("message", (d) => {
      const f = JSON.parse(String(d));
      if (f.type !== "list") return;
      const agents =
        f.from_ref === "ses_n"
          ? [row("writer", "pi", "notes", "live")]
          : [
              row("alpha", "pi", "ns", "live"),
              row("remote", "claude-code", "ns", "queued"),
            ];
      h.hubSock()?.send(
        JSON.stringify({ v: 1, id: f.id, type: "roster", agents }),
      );
    });
    await h.adapter("ses_a", { kind: "pi", proposed_name: "alpha", cwd: "/w" });
    await h.adapter("ses_n", {
      kind: "pi",
      proposed_name: "writer",
      cwd: "/notes",
    });
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st).toMatchObject({
      pid: process.pid,
      version: "9.9.9",
      label: "laptop",
      hub: "connected",
      namespaces: [
        {
          namespace: "ns",
          agents: [
            { name: "alpha", kind: "pi", machine: "laptop", state: "live" },
            {
              name: "remote",
              kind: "claude-code",
              machine: "",
              state: "queued",
            },
          ],
        },
        {
          namespace: "notes",
          agents: [
            { name: "writer", kind: "pi", machine: "laptop", state: "live" },
          ],
        },
      ],
    });
    // With a cwd, only that namespace.
    const cwd = await daemonStatus({
      path: h.socketPath,
      cwd: "/notes/x",
      timeoutMs: 3000,
    });
    expect(cwd.namespace).toBe("notes");
    expect(cwd.namespaces.map((n) => n.namespace)).toEqual(["notes"]);
  });

  it("uses the hub's machine_label, else our label for ours and blank", async () => {
    const h = await daemonHarness({
      claude: { syncMs: 3_600_000 },
      resolveNamespace,
    });
    h.hubSock()?.on("message", (d) => {
      const f = JSON.parse(String(d));
      if (f.type !== "list") return;
      const agents = [
        { ...row("alpha", "pi", "ns", "live"), machine_label: "mine-x" },
        {
          ...row("remote", "claude-code", "ns", "live"),
          machine_label: "desktop",
        },
        row("older", "claude-code", "ns", "live"),
      ];
      h.hubSock()?.send(
        JSON.stringify({ v: 1, id: f.id, type: "roster", agents }),
      );
    });
    await h.adapter("ses_a", { kind: "pi", proposed_name: "alpha", cwd: "/w" });
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    expect(st.namespaces[0]?.agents.map((a) => a.machine)).toEqual([
      "mine-x",
      "desktop",
      "",
    ]);
  });

  it("falls back to this machine's sessions when the hub does not answer", async () => {
    const h = await daemonHarness({
      claude: { syncMs: 3_600_000 },
      resolveNamespace,
      statusRosterMs: 50,
    });
    await h.adapter("ses_a", { kind: "pi", proposed_name: "alpha", cwd: "/w" });
    const st = await daemonStatus({
      path: h.socketPath,
      cwd: "/w",
      timeoutMs: 3000,
    });
    expect(st.namespaces).toEqual([
      {
        namespace: "ns",
        agents: [
          { name: "alpha", kind: "pi", machine: "laptop", state: "live" },
        ],
      },
    ]);
    const empty = await daemonStatus({
      path: h.socketPath,
      cwd: "/notes",
      timeoutMs: 3000,
    });
    expect(empty).toMatchObject({
      namespace: "notes",
      namespaces: [{ namespace: "notes", agents: [] }],
    });
  });

  it("writes the revoked marker when the hub revokes this machine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-rv-"));
    const onRevoked = vi.fn();
    const h = await daemonHarness({
      revokedFile: join(dir, "revoked"),
      onRevoked,
    });
    h.hubSock()?.close(4403, "revoked");
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalledOnce());
    expect(JSON.parse(readFileSync(join(dir, "revoked"), "utf8")).at).toMatch(
      /^\d{4}-/,
    );
    expect(existsSync(join(dir, "revoked"))).toBe(true);
    process.exitCode = 0;
  });
});

describe("hub lastError", () => {
  it("names a refused connection", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const hub = new HubConnection(
      opts(`ws://127.0.0.1:${port}/hub`, { backoffMs: () => 3_600_000 }),
    );
    hub.start();
    await vi.waitFor(() => expect(hub.lastError).toBe("ECONNREFUSED"));
    hub.stop();
  });
});
