// Re-review of the track-review fixes (b30542e). `it.fails` until fixed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeTransport } from "../src/transports/claude.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const servers: Server[] = [];
const transports: ClaudeTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.close()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

const agent = {
  ref: "s1",
  kind: "claude-code",
  proposedName: "a",
  busName: "a",
  namespace: "n",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
} as const;

describe("review: a daemon that died before the injection landed", () => {
  it.fails("never acks a message Claude never received", async () => {
    const d = tmp("ob-rvf-");
    const sock = join(d, "claude.sock");
    const seen: string[] = [];
    const server = createServer((s) => {
      s.on("error", () => {});
      createInterface({ input: s }).on("line", (line) => {
        const f = JSON.parse(line) as Record<string, unknown>;
        if (f.type === "user") seen.push(String(f.msg_id));
      });
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    servers.push(server);
    const heldFile = join(d, "claude-held.json");
    // What a daemon killed (crash, OOM, SIGKILL, power) between recording the
    // msg_id and inject() writing the frame leaves on disk: the record, and
    // nothing in Claude. It is the same file a stop inside the status window leaves.
    writeFileSync(
      join(d, "claude-held.injected.json"),
      JSON.stringify({ m1: Date.now() }),
    );
    const t = new ClaudeTransport({
      socketsDir: join(tmp("ob-rvfs-"), "r"),
      heldFile,
      statusWindowMs: 40,
      target: () => ({ socketPath: sock, peerToken: "tok" }),
    });
    transports.push(t);
    const out = await t.deliver(agent, {
      msg_id: "m1",
      from_name: "peer",
      namespace: "n",
      body: "hi",
    });
    // Acked (the sender sees "delivered") while Claude has nothing.
    expect(out.ok && seen.length === 0).toBe(false);
  });
});
