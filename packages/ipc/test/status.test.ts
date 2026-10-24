import { describe, expect, it } from "vitest";
import { daemonStatus } from "../src/client.ts";
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
    await expect(daemonStatus({ path })).rejects.toThrow(/refused status/);
    await s.close();
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
});
