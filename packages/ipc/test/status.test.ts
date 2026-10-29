import { mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonSilentError, daemonStatus } from "../src/client.ts";
import { serveDaemon } from "../src/server.ts";
import { fakeDaemon, ok, tmpSock } from "./helpers.ts";

const answer = {
  pid: 4242,
  version: "0.1.0",
  label: "laptop",
  hub: "connected" as const,
  hub_error: "ECONNREFUSED",
  namespaces: [
    {
      namespace: "github.com/o/r",
      agents: [
        {
          name: "a",
          kind: "pi" as const,
          machine: "laptop",
          state: "live" as const,
        },
      ],
    },
  ],
};

describe("daemon status", () => {
  it("answers without a hello, then closes", async () => {
    const path = tmpSock();
    const seen: (string | undefined)[] = [];
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
      onStatus: async (req) => {
        seen.push(req.cwd);
        return answer;
      },
    });
    const got = await daemonStatus({ path, cwd: "/w" });
    expect(got).toMatchObject({ type: "status", ...answer });
    expect(seen).toEqual(["/w"]);
    await s.close();
  });

  it("is refused by a daemon that does not serve status", async () => {
    const path = tmpSock();
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
    });
    const err = await daemonStatus({ path }).catch((e) => e);
    expect(err).toBeInstanceOf(DaemonSilentError);
    expect(err.message).toMatch(/refused status/);
    await s.close();
  });

  it("a listener that answers garbage, or closes at once, is silent, not missing", async () => {
    const p1 = tmpSock();
    const garbage = await fakeDaemon(p1, (sock) => sock.write("not json\n"));
    await expect(daemonStatus({ path: p1 })).rejects.toBeInstanceOf(
      DaemonSilentError,
    );
    garbage.close();
    const p2 = tmpSock();
    const closer = await fakeDaemon(p2, (sock) => sock.destroy());
    await expect(daemonStatus({ path: p2 })).rejects.toBeInstanceOf(
      DaemonSilentError,
    );
    closer.close();
  });

  it("connect failures (no file, not a socket, refused) are plain errors", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ob-ns-")), "plain");
    writeFileSync(file, "");
    for (const p of [file, join(file, "x"), tmpSock()]) {
      const e = await daemonStatus({ path: p }).catch((x) => x);
      expect(e).not.toBeInstanceOf(DaemonSilentError);
      expect(["ENOTSOCK", "ENOTDIR", "ECONNREFUSED", "ENOENT"]).toContain(
        e.code,
      );
    }
  });

  it("nothing listening is a plain error, not DaemonSilentError", async () => {
    const err = await daemonStatus({ path: tmpSock() }).catch((e) => e);
    expect(err).not.toBeInstanceOf(DaemonSilentError);
  });

  it("rejects when nothing listens, and when the daemon stays silent", async () => {
    await expect(daemonStatus({ path: tmpSock() })).rejects.toThrow();
    const path = tmpSock();
    const srv = await fakeDaemon(path, () => {});
    await expect(daemonStatus({ path, timeoutMs: 100 })).rejects.toThrow(
      /did not answer/,
    );
    srv.close();
  });

  it("one un-helloed connection gets one status, not one hub roster round per frame", async () => {
    const path = tmpSock();
    let calls = 0;
    const s = await serveDaemon({
      path,
      onHello: ok,
      onFrame: () => undefined,
      onStatus: async () => {
        calls++;
        return {
          pid: 1,
          version: "0",
          label: "l",
          hub: "connected" as const,
          namespaces: [],
        };
      },
    });
    const line = `${JSON.stringify({ v: 1, id: "s", type: "status" })}\n`;
    await new Promise<void>((resolve) => {
      const sock = connect(path, () => sock.write(line.repeat(50)));
      sock.on("data", () => {});
      sock.on("close", () => resolve());
      sock.on("error", () => resolve());
    });
    await s.close();
    expect(calls).toBe(1);
  });
});
