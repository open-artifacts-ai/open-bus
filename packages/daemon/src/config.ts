import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Config = {
  hub: string;
  machine_id: string;
  label: string;
  machine_token: string;
};

export const home = () =>
  process.env.OPENBUS_HOME ?? join(homedir(), ".openbus");
export const socketPath = () => join(home(), "daemon.sock");

export function readConfig(): Config {
  const raw = JSON.parse(
    readFileSync(join(home(), "machine.json"), "utf8"),
  ) as Partial<Config>;
  const hub = process.env.OPENBUS_HUB ?? raw.hub;
  if (!hub || !raw.machine_token) {
    throw new Error("not logged in: run `open-bus login`");
  }
  return {
    ...raw,
    hub,
    machine_id: raw.machine_id ?? "",
    label: raw.label ?? "machine",
  } as Config;
}
