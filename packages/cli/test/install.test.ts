import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { install } from "../src/commands/install.ts";
import type { Ctx } from "../src/context.ts";
import { copy } from "../src/copy.ts";
import {
  deviceCode,
  type Fake,
  fakeCtx,
  HUB,
  LABEL,
  NS,
  status,
  TAGS,
  TOKEN,
  transcript,
  URL_,
} from "./fake.ts";

const AGENTS = [
  ["openbus-backend", "claude-code"],
  ["openbus-design", "claude-code"],
  ["openbus-e0", "opencode"],
  ["openbus-frontend", "pi", "leo-linux-box"],
  ["openbus-platform", "claude-code", "leo-mac-mini", "queued"],
].map(([name, kind, machine, state]) => ({
  name: name as string,
  kind: kind as "claude-code" | "opencode" | "pi",
  machine: machine ?? LABEL,
  state: (state ?? "live") as "live" | "queued",
}));
const withAgents = (agents = AGENTS) =>
  status({ namespaces: [{ namespace: NS, agents }] });

/** A hub that answers /device/code, then each poll in turn. */
function hub(polls: unknown[], code: () => Response = deviceCode) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/device/code")) return code();
    const next = polls.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as unknown as typeof fetch;
}
const approved = {
  status: "approved",
  machine_id: "mmmmmmmmmmmmmmm1",
  token: TOKEN,
};

const allHarnesses = (over: Partial<Ctx> = {}) => ({
  which: (c: string) => ["claude", "opencode", "pi"].includes(c),
  exec: vi.fn(async (cmd: string, args: string[]) =>
    cmd === "opencode" && args[0] === "--version"
      ? { code: 0, stdout: "opencode v2.0.32\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" },
  ),
  service: {
    kind: "launchd" as const,
    ensure: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
  },
  status: vi.fn(async () => withAgents()),
  ...over,
});

const run = (ctx: Fake, opts: Parameters<typeof install>[0] = {}) =>
  install({ label: LABEL, hub: HUB, ...opts }, ctx);

describe("install: transcript state 1, first run", () => {
  it("prints every line of the transcript, non-TTY", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "pending" }, approved]),
      ...allHarnesses(),
    });
    expect(await run(ctx)).toBe(0);
    const [first, after] = transcript("## 1. First run, browser opens");
    const waiting = (first as string[]).length - 1;
    expect(ctx.out()).toEqual([
      ...(first as string[]).slice(0, waiting),
      "Waiting for approval (up to 10 minutes)…",
      ...(after as string[]),
    ]);
    expect(ctx.err()).toEqual([]);
    // The browser got the URL; the token never reached stdout.
    expect(ctx.openBrowser).toHaveBeenCalledWith(URL_);
    expect(ctx.out().join("\n")).not.toContain(TOKEN);
  });

  it("on a TTY draws the spinner with time left, then erases it", async () => {
    const ctx = fakeCtx(
      { fetch: hub([{ status: "pending" }, approved]), ...allHarnesses() },
      true,
    );
    expect(await run(ctx)).toBe(0);
    const [first] = transcript("## 1. First run, browser opens");
    const raw = ctx.raw();
    expect(raw).toContain(
      "[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]10:00 left[[/muted]]\n\x1b[1F\x1b[0J",
    );
    expect(raw).not.toContain("Waiting for approval (up to");
    // The transcript's own example frame renders exactly.
    expect(copy(TAGS).waiting("⠋", (9 * 60 + 41) * 1000, false)).toBe(
      (first as string[]).at(-1),
    );
  });

  it("marks a failing poll on the spinner line until one succeeds", () => {
    expect(copy(TAGS).waiting("⠋", 581_000, true)).toBe(
      "[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]9:41 left[[/muted]]  [[warning]]hub unreachable, retrying[[/warning]]",
    );
  });

  it("lists only the harnesses found, and no OpenCode line without OpenCode", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: (c) => c === "claude" || c === "pi" }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Configured Claude Code and Pi",
    );
    expect(ctx.out().join("\n")).not.toContain("OpenCode service");
  });

  it("says when the OpenCode service is not running", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        exec: vi.fn(async (_cmd: string, args: string[]) =>
          args[0] === "--version"
            ? { code: 0, stdout: "opencode v2.0.32", stderr: "" }
            : args[0] === "service"
              ? { code: 1, stdout: "", stderr: "service not running" }
              : { code: 0, stdout: "", stderr: "" },
        ),
      }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  OpenCode service not running; it loads the plugin when it starts",
    );
  });

  it("warns, and still succeeds, when no harness is found", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ which: () => false }),
    });
    expect(await run(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  No Claude Code, OpenCode or Pi found",
        "   Install one, then run npx open-bus again.",
      ]),
    );
  });

  it("prints the upgrade line for an OpenCode below 2.0.0", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        which: (c) => c === "opencode",
        exec: vi.fn(async () => ({
          code: 0,
          stdout: "opencode v1.4.2",
          stderr: "",
        })),
      }),
    });
    expect(await run(ctx)).toBe(0);
    // The same two lines as doctor's (transcript state 8).
    const doctor = transcript("## 8. doctor")[1] as string[];
    const i = doctor.findIndex((l) => l.includes("OpenCode 1.4.2"));
    expect(ctx.out()).toEqual(expect.arrayContaining(doctor.slice(i, i + 2)));
  });

  it("no agents yet: the namespace line and the join hint, no table", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({ status: vi.fn(async () => withAgents([])) }),
    });
    await run(ctx);
    expect(ctx.out().slice(-4)).toEqual([
      `No agents in namespace [[accent]]${NS}[[/accent]] yet.`,
      "Start Claude Code, OpenCode or Pi in this folder and it joins.",
      "",
      "[[muted]]Check this machine anytime with npx open-bus status.[[/muted]]",
    ]);
  });

  it("names a systemd user service on Linux", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        service: {
          kind: "systemd",
          ensure: async () => {},
          remove: async () => true,
        },
      }),
    });
    await run(ctx);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
    );
  });
});

describe("install: daemon confirmation", () => {
  it("prints Daemon running only after the socket answers", async () => {
    let calls = 0;
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        status: vi.fn(async () => {
          if (++calls < 3) throw new Error("ECONNREFUSED");
          return status();
        }),
      }),
    });
    expect(await run(ctx)).toBe(0);
    expect(calls).toBe(3);
    expect(ctx.service.ensure).toHaveBeenCalledOnce();
  });

  it("gives up after 10 seconds: the transcript's failure, on stderr, nothing after", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      ...allHarnesses({
        status: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    });
    const start = ctx.clock.t;
    expect(await run(ctx)).toBe(1);
    // One 5 s approval poll, then the 10 s wait.
    expect(ctx.clock.t - start).toBeGreaterThanOrEqual(15_000);
    expect(ctx.clock.t - start).toBeLessThan(16_000);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  The daemon did not start within 10 seconds.",
      "   Run npx open-bus doctor to see why.",
    ]);
    expect(ctx.out().at(-1)).toMatch(/OpenCode service/);
  });
});

describe("install: transcript states 2 to 6", () => {
  it("2: no browser", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      openBrowser: vi.fn(async () => false),
      ...allHarnesses(),
    });
    await run(ctx);
    const [block] = transcript("## 2. No browser");
    expect(ctx.out().slice(0, 10)).toEqual([
      ...(block as string[]).slice(0, -1),
      "Waiting for approval (up to 10 minutes)…",
    ]);
  });

  it("2: --no-open never opens the browser and says so", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    await run(ctx, { noOpen: true });
    expect(ctx.openBrowser).not.toHaveBeenCalled();
    expect(ctx.out()[2]).toBe("→  Open this URL on any machine:");
    expect(ctx.out()[3]).toBe(`   [[accent]]${URL_}[[/accent]]`);
  });

  it("3: denied", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "denied" }]),
      ...allHarnesses(),
    });
    expect(await run(ctx)).toBe(1);
    expect(ctx.err()).toEqual(transcript("## 3. Denied")[0]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(false);
    expect(ctx.out().at(-1)).toBe("Waiting for approval (up to 10 minutes)…");
  });

  it("4: expired, from the hub or from the clock", async () => {
    const want = transcript("## 4. Expired")[0];
    const a = fakeCtx({
      fetch: hub([{ status: "expired" }]),
      ...allHarnesses(),
    });
    expect(await run(a)).toBe(1);
    expect(a.err()).toEqual(want);
    const b = fakeCtx({
      fetch: hub(Array(500).fill({ status: "pending" })),
      ...allHarnesses(),
    });
    expect(await run(b)).toBe(1);
    expect(b.err()).toEqual(want);
  });

  it("5: already registered", async () => {
    const ctx = fakeCtx(allHarnesses());
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "machine.json"),
      JSON.stringify({
        hub: HUB,
        machine_id: "m",
        label: LABEL,
        machine_token: TOKEN,
      }),
      { mode: 0o600 },
    );
    expect(await run(ctx)).toBe(0);
    const [block] = transcript("## 5. Already registered");
    expect(ctx.out().slice(0, 8)).toEqual((block as string[]).slice(0, 8));
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("6: retries /device/code at 2, 4 and 8 s, then succeeds", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/device/code")) {
        if (++n < 3)
          throw Object.assign(new TypeError("fetch failed"), {
            cause: { code: "ECONNREFUSED" },
          });
        return deviceCode();
      }
      return Response.json(approved);
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    expect(await run(ctx)).toBe(0);
    expect(ctx.sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(ctx.sleep).toHaveBeenNthCalledWith(2, 4000);
    const [block] = transcript("## 6. Hub unreachable");
    // Non-TTY: each attempt prints its own lines; the second is the transcript's.
    expect(ctx.out().slice(2, 6)).toEqual([
      "[[warning]]![[/warning]]  Couldn't reach bus.example.com",
      "   [[muted]]Retrying in 2 s… attempt 2 of 4[[/muted]]",
      ...(block as string[]).slice(2),
    ]);
    expect(ctx.out()[6]).toBe(
      "→  Opening your browser to approve this machine",
    );
  });

  it("6: on a TTY the retry lines are redrawn in place and erased on success", async () => {
    let n = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/device/code")) {
        if (++n < 2) return new Response("", { status: 502 });
        return deviceCode();
      }
      return Response.json(approved);
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() }, true);
    await run(ctx);
    expect(ctx.raw()).toContain(
      "attempt 2 of 4[[/muted]]\n\x1b[2F\x1b[0J→  Opening your browser",
    );
  });

  it("6: after the fourth failure, the final error with the last cause", async () => {
    const fetch = vi.fn(
      async () => new Response("", { status: 502 }),
    ) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    expect(await run(ctx)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  Couldn't reach bus.example.com after 4 attempts.  [[muted]]HTTP 502[[/muted]]",
      "   Check your network or the --hub URL, then run npx open-bus again.",
    ]);
    const [, final] = transcript("## 6. Hub unreachable");
    expect((final as string[])[1]).toBe(ctx.err()[1]);
    expect((final as string[])[0]).toBe(
      ctx.err()[0]?.replace("HTTP 502", "ECONNREFUSED"),
    );
  });

  it("6: a timeout is named timeout", async () => {
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx({ fetch, ...allHarnesses() });
    await run(ctx);
    expect(ctx.err()[0]).toMatch(/\[\[muted\]\]timeout\[\[\/muted\]\]$/);
  });
});

describe("install: no hub", () => {
  it("without --hub or OPENBUS_HUB it says how to pass one and exits 1", async () => {
    const ctx = fakeCtx(allHarnesses());
    expect(await install({ label: LABEL }, ctx)).toBe(1);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  No hub to connect to.",
      "   Run npx open-bus --hub https://<your-hub>, or set OPENBUS_HUB.",
    ]);
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("OPENBUS_HUB is enough", async () => {
    const ctx = fakeCtx({
      fetch: hub([approved]),
      env: { OPENBUS_HUB: HUB },
      ...allHarnesses(),
    });
    expect(await install({ label: LABEL }, ctx)).toBe(0);
  });
});

describe("install: steps and install.json", () => {
  it("records each step and keeps the adapters' container records", async () => {
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses() });
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(
      join(ctx.home, "install.json"),
      JSON.stringify({ created: { "/x": [["mcp"]] } }),
    );
    await run(ctx);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.created["/x"]).toEqual([["mcp"]]);
    expect(Object.keys(rec.steps)).toEqual(["login", "harnesses", "daemon"]);
    expect(rec.steps.daemon.status).toBe("ok");
  });

  it("stops at the first failed step and records it", async () => {
    const ctx = fakeCtx({
      fetch: hub([{ status: "denied" }]),
      ...allHarnesses(),
    });
    await run(ctx);
    const rec = JSON.parse(
      readFileSync(join(ctx.home, "install.json"), "utf8"),
    );
    expect(rec.steps).toEqual({
      login: expect.objectContaining({ status: "failed" }),
    });
    expect(ctx.service.ensure).not.toHaveBeenCalled();
  });

  it("--check runs every check, writes nothing and exits 1 when one is todo", async () => {
    const ctx = fakeCtx(
      allHarnesses({
        status: vi.fn(async () => {
          throw new Error("down");
        }),
      }),
    );
    expect(await run(ctx, { check: true })).toBe(1);
    expect(ctx.out()).toEqual([
      "open-bus 0.1.0",
      "",
      "[[warning]]![[/warning]]  Machine approved: not done",
      "   Run npx open-bus to set it up.",
      "[[warning]]![[/warning]]  Harnesses configured: not done",
      "   Run npx open-bus to set it up.",
      "[[warning]]![[/warning]]  Daemon answering: not done",
      "   Run npx open-bus to set it up.",
    ]);
    expect(existsSync(ctx.home)).toBe(false);
    expect(ctx.exec).not.toHaveBeenCalled();
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("--check passes after an install", async () => {
    // `claude mcp add` fails here, so install writes ~/.claude.json itself.
    const exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "claude"
        ? { code: 1, stdout: "", stderr: "no" }
        : args[0] === "--version"
          ? { code: 0, stdout: "opencode v2.0.32", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = fakeCtx({ fetch: hub([approved]), ...allHarnesses({ exec }) });
    await run(ctx);
    const again = fakeCtx({
      ...allHarnesses(),
      userHome: ctx.userHome,
      home: ctx.home,
    });
    expect(await run(again, { check: true })).toBe(0);
    expect(again.out().slice(2)).toEqual([
      "[[success]]✓[[/success]]  Machine approved",
      "[[success]]✓[[/success]]  Harnesses configured",
      "[[success]]✓[[/success]]  Daemon answering",
    ]);
  });
});
