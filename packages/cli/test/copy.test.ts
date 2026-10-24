import { describe, expect, it } from "vitest";
import { copy, cutMiddle, tokenTail } from "../src/copy.ts";
import { detectStyle, paint, type Style } from "../src/term.ts";
import { TAGS, transcript } from "./fake.ts";

const NONE: Style = { color: "none", dark: true, utf8: true };
const c = copy(TAGS);
const plain = copy(NONE);

describe("transcript parity: the roster", () => {
  const block = transcript("## 1. First run, browser opens")[1] as string[];
  const rows = block.filter((l) => l.startsWith("  openbus-"));
  const machine = (l: string) => l.slice(35, 57).trim();

  it("renders each row of the transcript's table", () => {
    for (const row of rows) {
      const [name, kind] = [row.slice(2, 22).trim(), row.slice(22, 35).trim()];
      const kinds: Record<string, string> = {
        "Claude Code": "claude-code",
        OpenCode: "opencode",
        Pi: "pi",
      };
      expect(
        c.rosterRow({
          name,
          kind: kinds[kind] as string,
          machine: machine(row),
          state: row.includes("queued") ? "queued" : "live",
        }),
      ).toBe(row);
    }
    expect(rows).toHaveLength(5);
  });

  it("renders the header, the queued footnote and the more line", () => {
    expect(c.rosterHeader("github.com/open-artifacts-ai/open-bus", 4, 1)).toBe(
      block.find((l) => l.startsWith("5 agents")),
    );
    const i = block.findIndex((l) => l.includes("Mail to a queued agent"));
    expect(c.queuedFootnote()).toEqual(block.slice(i, i + 2));
    expect(c.rosterMore(7)).toBe(
      "  [[muted]]and 7 more · npx open-bus status[[/muted]]",
    );
    expect(c.rosterHeader("ns", 1, 0)).toMatch(/^1 agent in namespace/);
  });

  it("cuts a long cell to its width minus 2 plus …, keeping a space", () => {
    const row = plain.rosterRow({
      name: "n".repeat(30),
      kind: "claude-code",
      machine: "m".repeat(40),
      state: "live",
    });
    expect(row).toBe(
      `  ${"n".repeat(18)}… Claude Code  ${"m".repeat(20)}… ● live`,
    );
    expect([...row].length).toBe(63);
    const queued = plain.rosterRow({
      name: "n",
      kind: "pi",
      machine: "m".repeat(40),
      state: "queued",
    });
    // The widest row is 65 columns.
    expect([...queued].length).toBe(65);
  });
});

describe("cutting long values", () => {
  it("cuts the middle, keeping the end, to the transcript's example", () => {
    const ns = `github.com/very-long-org${"x".repeat(95)}/open-bus`;
    expect(ns).toHaveLength(128);
    const line = plain.rosterHeader(ns, 4, 1);
    expect([...line].length).toBeLessThanOrEqual(80);
    expect(line).toMatch(
      /^5 agents in namespace github\.com\/very-long-orgx*…\/open-bus {2}4 live · 1 queued$/,
    );
    expect(cutMiddle("abcdefghij", 5)).toBe("ab…ij");
  });

  it("keeps every line within 80 columns for 128-character values", () => {
    const long = "L".repeat(128);
    const lines = [
      plain.approved(long),
      plain.alreadyConnected(long),
      plain.connectedTo(long, `${"h".repeat(100)}.example.com`),
      plain.rosterHeader(long, 9, 9),
      ...plain.noAgents(long),
      ...plain.unreachable(`${"h".repeat(120)}.com`, 4, 3, 4),
      ...plain.unreachableFinal(`${"h".repeat(120)}.com`, 4, "ECONNREFUSED"),
      ...plain.opencodeTooOld(long, "2.0.0"),
      ...plain.skipped("opencode", long),
      ...plain.couldNotRemove("claude", long),
      ...plain.kept(`/${long}`),
      ...plain.purged(`/${long}`),
      ...plain.purgeLeftDir(`/${long}`),
      ...plain.machineFileOpen(`/${long}`),
      ...plain.daemonNotAnswering(`/${long}`),
      ...plain.noLog(`/${long}`),
      ...plain.failed(long),
      plain.footer("0.1.0", "v24.0.0", "darwin arm64", `/${long}`),
    ];
    for (const l of lines) expect([...l].length, l).toBeLessThanOrEqual(80);
  });

  it("never shows more of a token than its prefix and 4 characters", () => {
    expect(tokenTail(`ob_machine_${"a".repeat(28)}7f3a`)).toBe(
      "ob_machine_…7f3a",
    );
  });
});

describe("drafted copy (pending Design's addendum)", () => {
  it("pins the OpenCode upgrade line", () => {
    expect(c.opencodeTooOld("1.9.4", "2.0.0")).toEqual([
      "[[warning]]![[/warning]]  OpenCode 1.9.4 is older than 2.0.0, so OpenBus skipped it.",
      "   Upgrade OpenCode, then run npx open-bus again.",
    ]);
  });
});

describe("terminal style (PALETTE.md)", () => {
  const tty = { isTTY: true, hasColors: (d?: number) => (d ?? 16) <= 256 };
  it("NO_COLOR and --no-color turn colour off; glyphs stay", () => {
    expect(detectStyle({ NO_COLOR: "1" }, tty).color).toBe("none");
    expect(detectStyle({}, tty, true).color).toBe("none");
    expect(detectStyle({ FORCE_COLOR: "3" }, tty, true).color).toBe("none");
  });
  it("FORCE_COLOR: 0 off, 3 truecolor, anything else ANSI 16", () => {
    expect(detectStyle({ FORCE_COLOR: "0" }, tty).color).toBe("none");
    expect(detectStyle({ FORCE_COLOR: "3" }, {}).color).toBe("truecolor");
    expect(detectStyle({ FORCE_COLOR: "2" }, {}).color).toBe("ansi");
  });
  it("otherwise only a colour TTY, truecolor when it says so; TERM=dumb is off", () => {
    expect(detectStyle({}, {}).color).toBe("none");
    expect(detectStyle({}, tty).color).toBe("ansi");
    expect(detectStyle({ COLORTERM: "truecolor" }, tty).color).toBe(
      "truecolor",
    );
    expect(detectStyle({ TERM: "dumb" }, tty).color).toBe("none");
  });
  it("COLORFGBG picks light for a 7 or 15 background, else dark", () => {
    expect(detectStyle({ COLORFGBG: "0;15" }, {}).dark).toBe(false);
    expect(detectStyle({ COLORFGBG: "15;0" }, {}).dark).toBe(true);
    expect(detectStyle({}, {}).dark).toBe(true);
  });
  it("UTF-8 glyphs only for a UTF-8 locale; ASCII otherwise", () => {
    expect(detectStyle({ LANG: "en_US.UTF-8" }, {}).utf8).toBe(true);
    const ascii = copy({ color: "none", dark: true, utf8: false });
    expect(ascii.approved("x")).toBe("+  Approved as x");
    expect(ascii.codeBox("K3M7-QW29")[0]).toBe("   +-------------+");
    expect(ascii.waitingPlain()).toBe(
      "Waiting for approval (up to 10 minutes)...",
    );
  });
  it("paints from @ob/ui's palette: truecolor, ANSI slots, never a background", () => {
    expect(
      paint({ color: "truecolor", dark: true, utf8: true }, "danger", "x"),
    ).toBe("\x1b[38;2;255;127;107mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: true, utf8: true }, "danger", "x"),
    ).toBe("\x1b[91mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: false, utf8: true }, "success", "x"),
    ).toBe("\x1b[32mx\x1b[39m");
    expect(
      paint({ color: "ansi", dark: true, utf8: true }, "hairline", "x"),
    ).toBe("x");
  });
});
