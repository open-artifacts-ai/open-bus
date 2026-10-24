// C15: status, doctor and purge find the daemon's short socket folder.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortSocketDir } from "@ob/adapter-claude-code";
import { runDaemon, StartError } from "@ob/daemon";
import { newMachineToken } from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { purge } from "../src/steps/purge.ts";
import { fakeCtx, status } from "./fake.ts";

const made: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  for (const p of made.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** A home over 104 bytes holding machine.json; its short folder is cleaned up. */
function longHome(): string {
  const h = join(mkdtempSync(join(tmpdir(), "ob-cl-long-")), "x".repeat(110));
  mkdirSync(h, { recursive: true });
  writeFileSync(
    join(h, "machine.json"),
    JSON.stringify({
      hub: "https://bus.example.com",
      machine_id: "m",
      label: "laptop",
      machine_token: newMachineToken(),
    }),
    { mode: 0o600 },
  );
  made.push(shortSocketDir(h));
  return h;
}

const listen = async (path: string) => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(path, () => r()));
  servers.push(s);
};

describe("a long OPENBUS_HOME", () => {
  it("status and doctor dial the short folder's socket", async () => {
    const home = longHome();
    const want = join(shortSocketDir(home), "daemon.sock");
    for (const run of [statusCmd, doctor]) {
      const st = vi.fn(async (_req: { path: string }) => status());
      const ctx = fakeCtx({ home, status: st });
      await run(ctx);
      expect(st.mock.calls[0]?.[0]).toMatchObject({ path: want });
    }
  });

  it("doctor names an unsafe short folder and how to fix it", async () => {
    const home = longHome();
    const dir = shortSocketDir(home);
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const ctx = fakeCtx({ home });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining(
        ctx.copy.socketFolderUnsafe(
          dir,
          "is open to other users (mode 755)",
        ) as string[],
      ),
    );
  });

  it("purge removes the short folder's sockets and the folder", async () => {
    const home = longHome();
    const dir = shortSocketDir(home);
    mkdirSync(join(dir, "claude-return"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    await listen(join(dir, "daemon.sock"));
    await listen(join(dir, "claude-return", "ab12cd34.sock"));
    const out = purge(home, { isDefault: false });
    expect(out).toMatchObject({ leftDir: false });
    expect(existsSync(dir)).toBe(false);
  });

  it("purge never follows a symlinked short folder", async () => {
    const home = longHome();
    const target = mkdtempSync(join(tmpdir(), "ob-cl-target-"));
    made.push(target);
    writeFileSync(join(target, "daemon.sock"), "");
    symlinkSync(target, shortSocketDir(home));
    purge(home, { isDefault: false });
    expect(existsSync(join(target, "daemon.sock"))).toBe(true);
  });

  it("under a service, a socket it cannot bind exits 0 (no restart loop); in a terminal, 1", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "ob-cl-sock-")),
      "z".repeat(120),
    );
    for (const [env, code] of [
      [{ OPENBUS_SERVICE: "1" }, 0],
      [{}, 1],
    ] as const) {
      const ctx = fakeCtx({ env });
      let err: unknown;
      const exit = await daemon(
        ctx,
        (deps) =>
          runDaemon({
            ...deps,
            config: {
              hub: "wss://bus.example.com",
              machine_id: "m1",
              label: "laptop",
              machine_token: "ob_machine_SECRETSECRETSECRET",
            },
            socketPath: path,
          }).catch((e) => {
            err = e;
            throw e;
          }),
        new (await import("node:events")).EventEmitter() as never,
      );
      expect(err).toBeInstanceOf(StartError);
      expect(err).toMatchObject({ code: "SOCKET_PATH" });
      expect(exit).toBe(code);
    }
  });
});
