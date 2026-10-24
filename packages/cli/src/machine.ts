import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMachineToken } from "@ob/shared";

export type Machine =
  | { state: "missing" }
  | { state: "bad" }
  | {
      state: "ok";
      hub: string;
      label: string;
      token: string;
      /** Readable by group or others. */
      open: boolean;
    };

/** machine.json as the commands need it; callers never print `token`. */
export function readMachine(home: string): Machine {
  const file = join(home, "machine.json");
  let text: string;
  let mode: number;
  try {
    mode = statSync(file).mode;
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "bad" };
  }
  try {
    const m = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof m.hub === "string" &&
      typeof m.label === "string" &&
      isMachineToken(m.machine_token)
    )
      return {
        state: "ok",
        hub: m.hub,
        label: m.label,
        token: m.machine_token as string,
        open: process.platform !== "win32" && (mode & 0o077) !== 0,
      };
  } catch {}
  return { state: "bad" };
}
