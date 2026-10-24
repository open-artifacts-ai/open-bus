// An empty OPENBUS_HOME is unset: the tool server dials ~/.openbus, never its cwd.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { openbusHome, procStartOf } from "../src/session.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

/** A daemon at <home>/.openbus/daemon.sock that records each hello's agent_ref. */
async function daemonIn(home: string) {
  mkdirSync(join(home, ".openbus"), { mode: 0o700 });
  const hellos: string[] = [];
  const server: Server = createServer((s) => {
    s.on("error", () => {});
    createInterface({ input: s }).once("line", (l) => {
      hellos.push(String(JSON.parse(l).agent_ref));
      s.destroy();
    });
  });
  await new Promise<void>((r) =>
    server.listen(join(home, ".openbus", "daemon.sock"), () => r()),
  );
  cleanup.push(() => new Promise((r) => server.close(() => r())));
  return hellos;
}

describe("openbusHome", () => {
  it("treats an empty OPENBUS_HOME as unset", () => {
    expect(openbusHome({ OPENBUS_HOME: "" })).toBe(join(homedir(), ".openbus"));
    expect(openbusHome({})).toBe(join(homedir(), ".openbus"));
  });

  it("is absolute, even when OPENBUS_HOME is relative", () => {
    expect(openbusHome({ OPENBUS_HOME: "rel/home" })).toBe(
      join(process.cwd(), "rel/home"),
    );
  });
});

describe("claude tool server with an empty OPENBUS_HOME", () => {
  it("dials ~/.openbus/daemon.sock, not one in its cwd", async () => {
    const home = tmp("ob-h-");
    const hellos = await daemonIn(home);
    // The server's parent is this process: make it the Claude session.
    const sessions = tmp("ob-hs-");
    writeFileSync(
      join(sessions, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        sessionId: "s-home",
        procStart: procStartOf(process.pid),
        cwd: "/",
      }),
    );
    const client = new Client({ name: "t", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN],
        cwd: tmp("ob-hc-"),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          OPENBUS_HOME: "",
          OPENBUS_CLAUDE_SESSIONS_DIR: sessions,
        },
        stderr: "ignore",
      }),
    );
    cleanup.push(() => client.close());
    await client.callTool({ name: "list_agents", arguments: {} });
    expect(hellos).toEqual(["s-home"]);
  });
});
