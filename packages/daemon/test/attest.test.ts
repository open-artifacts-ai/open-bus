import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attest } from "../src/attest.ts";
import { hello } from "./helpers.ts";

const sessions = (file?: object) => {
  const dir = mkdtempSync(join(tmpdir(), "ob-claude-"));
  if (file)
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify(file));
  return dir;
};
const claude = (agent_ref: string) =>
  hello({ kind: "claude-code", agent_ref, pid: process.pid });
const deps = (sessionsDir: string, start: string | null = "x") => ({
  sessionsDir,
  ancestors: () => [process.pid],
  procStart: () => start,
});

describe("attestation", () => {
  it("refuses a claude agent_ref that does not match the ancestor session file", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "other",
      procStart: "x",
    });
    expect(attest(claude("mine"), deps(dir))).toEqual({
      ok: false,
      reason: "agent_ref does not match a live Claude session",
    });
  });

  it("accepts the matching session when procStart agrees", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "x",
    });
    expect(attest(claude("mine"), deps(dir))).toEqual({ ok: true });
  });

  it("refuses a reused pid whose procStart moved", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "old",
    });
    expect(attest(claude("mine"), deps(dir, "new"))).toEqual({
      ok: false,
      reason: "session process start time moved",
    });
  });

  it("refuses a session whose process is gone", () => {
    const dir = sessions({
      pid: process.pid,
      sessionId: "mine",
      procStart: "x",
    });
    expect(attest(claude("mine"), deps(dir, null))).toEqual({
      ok: false,
      reason: "session process is not running",
    });
  });

  it("refuses when no ancestor has a session file", () => {
    expect(attest(claude("mine"), deps(sessions()))).toEqual({
      ok: false,
      reason: "no Claude session in the ancestry",
    });
  });

  it("refuses an opencode session with no live TUI presence file", () => {
    expect(
      attest(hello({ kind: "opencode", agent_ref: "ses_1" }), {
        openSessions: () => new Set(["ses_2"]),
      }),
    ).toEqual({ ok: false, reason: "opencode session is not open in a TUI" });
  });

  it("attests no opencode session by default", () => {
    expect(attest(hello({ kind: "opencode", agent_ref: "ses_1" })).ok).toBe(
      false,
    );
  });

  it("checks a pi process and its start time", () => {
    const pi = (proc_start?: string) =>
      hello({ kind: "pi", agent_ref: "p1", attest: { proc_start } });
    expect(attest(pi(), { procStart: () => null })).toEqual({
      ok: false,
      reason: "pi process is not running",
    });
    expect(attest(pi("a"), { procStart: () => "b" })).toEqual({
      ok: false,
      reason: "pi process start time moved",
    });
    expect(attest(pi("a"), { procStart: () => "a" })).toEqual({ ok: true });
  });
});
