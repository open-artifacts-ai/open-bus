import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeProcStartOf,
  findSession,
  procStartOf,
  statStartTicks,
} from "../src/session.ts";

/** A /proc/<pid>/stat line: `starttime` (field 22) is the only one that matters. */
const stat = (comm: string, starttime: string) =>
  `1234 (${comm}) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 11 0 ${starttime} 1000 50 18446744073709551615`;

const linux = (stats: Record<number, string>) => (pid: number) =>
  claudeProcStartOf(pid, {
    platform: "linux",
    readStat: (p) => {
      const s = stats[p];
      if (s === undefined) throw new Error("ENOENT");
      return s;
    },
  });

describe("statStartTicks", () => {
  it("reads field 22 after the last ')', whatever comm holds", () => {
    expect(statStartTicks(stat("claude", "207774019"))).toBe("207774019");
    expect(statStartTicks(stat("a) b (c)", "207774019"))).toBe("207774019");
    expect(statStartTicks(stat("x) S 1 2 3 4 5 6 7 8 9", "42"))).toBe("42");
  });

  it("refuses a line it cannot read", () => {
    expect(statStartTicks("")).toBeNull();
    expect(statStartTicks("1234 (claude S 1")).toBeNull();
    expect(statStartTicks("1234 (claude) S 1 2 3")).toBeNull();
  });
});

describe("claudeProcStartOf", () => {
  it("on Linux, returns Claude's procStart: the start in clock ticks", () => {
    expect(linux({ 1234: stat("claude", "207774019") })(1234)).toBe(
      "207774019",
    );
  });

  it("on Linux, a missing /proc entry fails closed", () => {
    expect(linux({})(1234)).toBeNull();
  });

  it("elsewhere, returns lstart, as Claude writes it on macOS", () => {
    expect(claudeProcStartOf(process.pid, { platform: "darwin" })).toBe(
      procStartOf(process.pid),
    );
    expect(procStartOf(process.pid)).toMatch(/^\w{3} \w{3} [ \d]\d /);
  });
});

describe("findSession on Linux", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-sess-"));
  writeFileSync(
    join(dir, "400.json"),
    JSON.stringify({ pid: 400, sessionId: "s400", procStart: "207774019" }),
  );
  const find = (starttime: string) =>
    findSession(500, {
      sessionsDir: dir,
      ancestors: () => [500, 400],
      procStart: linux({ 400: stat("claude", starttime) }),
    });

  it("finds the session whose start ticks match", () => {
    expect(find("207774019")?.sessionId).toBe("s400");
  });

  it("refuses a reused pid", () => {
    expect(find("207774020")).toBeNull();
  });
});
