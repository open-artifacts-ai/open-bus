import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
  /** The zone holding the host: pre-fills the setup token link. */
  zoneId?: string;
  /**
   * Set when access minted a client secret, cleared once secret bulk put it:
   * while set, the Worker's ACCESS_CLIENT_SECRET is stale, so access rotates.
   */
  clientSecretPending?: boolean;
};

/** HOME from the env; an unset, empty or relative one falls back to the OS home directory. */
export const homeOf = (env: Record<string, string | undefined>): string => {
  const h = env.HOME?.trim();
  return h && isAbsolute(h) ? h : homedir();
};

/** `~/.openbus/setup-<name>.json`. */
export const statePath = (home: string, name: string) =>
  join(home, ".openbus", `setup-${name}.json`);

export function readState(fs: Fs, home: string, name: string): State {
  const path = statePath(home, name);
  const text = fs.read(path);
  if (!text) return {};
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it`);
  }
  if (typeof state !== "object" || state === null || Array.isArray(state))
    throw new Error(`${path} does not hold a JSON object; fix or delete it`);
  return state as State;
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
