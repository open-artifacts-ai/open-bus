import { homedir } from "node:os";
import { join } from "node:path";
import type { Fs } from "./cf.ts";

export type State = {
  name?: string;
  accountId?: string;
  host?: string;
  ownerEmail?: string;
  /** Names of the steps that finished (ok or skipped), in order. */
  completed?: string[];
  accessAppId?: string;
  accessClientId?: string;
  teamDomain?: string;
  deployedVersion?: string;
};

/** HOME from the env; an unset or empty one falls back to the OS home directory. */
export const homeOf = (env: Record<string, string | undefined>): string =>
  env.HOME?.trim() || homedir();

/** `~/.openbus/setup-<name>.json`. */
export const statePath = (home: string, name: string) =>
  join(home, ".openbus", `setup-${name}.json`);

export function readState(fs: Fs, home: string, name: string): State {
  const text = fs.read(statePath(home, name));
  return text ? (JSON.parse(text) as State) : {};
}

/** Written 0600 in a 0700 directory when the fs can; state holds ids, never secrets. */
export function writeState(
  fs: Fs,
  home: string,
  name: string,
  state: State,
): void {
  const data = `${JSON.stringify(state, null, 2)}\n`;
  const path = statePath(home, name);
  if (fs.writeSecret) fs.writeSecret(path, data);
  else fs.write(path, data);
}
