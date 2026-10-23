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

export type Launcher = { cmd: string; args: string[] };

/** No shell on any platform: win32 uses rundll32, never `cmd /c start`. */
export const browserCommand = (
  platform: NodeJS.Platform,
  url: string,
): Launcher =>
  platform === "darwin"
    ? { cmd: "open", args: [url] }
    : platform === "win32"
      ? { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : { cmd: "xdg-open", args: [url] };

/** Resolves true once the launcher spawned, false if it could not start. */
export const openBrowser = (
  url: string,
  launcher: Launcher = browserCommand(process.platform, url),
): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      const child = spawn(launcher.cmd, launcher.args, {
        stdio: "ignore",
        detached: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });

export const realDeps: Deps = {
  fetch,
  print: (line) => console.log(line),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  openBrowser: (url) => openBrowser(url),
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
