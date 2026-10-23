import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export type Deps = {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  print: (line: string) => void;
  now: () => number;
  exec: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export const realDeps: Deps = {
  fetch,
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openBrowser: async (url) => {
    const win = process.platform === "win32";
    const cmd =
      process.platform === "darwin" ? "open" : win ? "cmd" : "xdg-open";
    const args = win ? ["/c", "start", "", url] : [url];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      return false;
    }
  },
  exec: async (cmd, args) => {
    try {
      const r = await promisify(execFile)(cmd, args, {
        maxBuffer: 8 * 1024 * 1024,
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? String(e),
      };
    }
  },
};
