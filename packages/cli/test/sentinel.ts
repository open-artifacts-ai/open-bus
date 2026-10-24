import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

/**
 * HOME and OPENBUS_HOME for every test that does not pass its own: the
 * service code resolves ~/Library/LaunchAgents and ~/.config/systemd/user
 * from HOME, so a unit written here is one a test forgot to point at a temp
 * home, and the file fails.
 */
export const SENTINEL_HOME = mkdtempSync(join(tmpdir(), "ob-cli-sentinel-"));
process.env.HOME = SENTINEL_HOME;
process.env.OPENBUS_HOME = join(SENTINEL_HOME, ".openbus");
delete process.env.XDG_CONFIG_HOME;

export const SERVICE_DIRS = ["Library/LaunchAgents", ".config/systemd/user"];

/** Files under the sentinel's service folders, as relative paths. */
export function serviceWrites(): string[] {
  return SERVICE_DIRS.flatMap((d) => {
    const dir = join(SENTINEL_HOME, d);
    return existsSync(dir)
      ? readdirSync(dir, { recursive: true }).map((f) => join(d, String(f)))
      : [];
  });
}

afterAll(() => expect(serviceWrites()).toEqual([]));
