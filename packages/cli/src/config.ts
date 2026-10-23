import { homedir } from "node:os";
import { join } from "node:path";

export const home = () =>
  process.env.OPENBUS_HOME ?? join(homedir(), ".openbus");
export const socketPath = () => join(home(), "daemon.sock");
export const machinePath = () => join(home(), "machine.json");
export const configPath = () => join(home(), "config.json");
export const installStatePath = () => join(home(), "install.json");
