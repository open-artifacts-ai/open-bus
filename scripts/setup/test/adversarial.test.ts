import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { statePath } from "../src/state.ts";
import type { Step } from "../src/step.ts";
import { prereqs } from "../src/steps/prereqs.ts";
import { core, FLAGS, HOME, ROOT, STATE } from "./fakes.ts";

const parsed = (lines: string[]) =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const leak = (msg: string): Step => ({
  name: "a",
  check: async () => "todo",
  apply: async () => {
    throw new Error(msg);
  },
});
const noop: Step = {
  name: "a",
  check: async () => "done",
  apply: async () => undefined,
};

describe("adversarial: scrubbing", () => {
  it("scrubs a short (< 8 char) CLOUDFLARE_API_TOKEN", async () => {
    const c = core({ env: { CLOUDFLARE_API_TOKEN: "s3kr1t7" } });
    await run(FLAGS, c.deps, ROOT, [leak("token s3kr1t7 rejected")]);
    expect(c.lines.join("\n")).not.toContain("s3kr1t7");
  });

  it("scrubs a secret that JSON escaping changed", async () => {
    const secret = 'abc"def\\ghi12345';
    const c = core({ env: { OB_ACCESS_TOKEN: secret } });
    await run(FLAGS, c.deps, ROOT, [leak(`bad token ${secret}`)]);
    const msg = String(parsed(c.lines).at(-1)?.message);
    expect(msg).not.toContain(secret);
  });

  it("scrubs the deploy token passed to wrangler children (deps.childEnv)", async () => {
    const c = core();
    c.deps.childEnv = { CLOUDFLARE_API_TOKEN: "filetoken-0123456789abcdef" };
    await run(FLAGS, c.deps, ROOT, [
      leak("auth failed for filetoken-0123456789abcdef"),
    ]);
    expect(c.lines.join("\n")).not.toContain("filetoken-0123456789abcdef");
  });

  it("scrubs other Cloudflare credentials wrangler honours (CLOUDFLARE_API_KEY, CF_API_TOKEN)", async () => {
    const c = core({
      env: {
        CLOUDFLARE_API_KEY: "globalkey-0123456789abcdef",
        CF_API_TOKEN: "legacytok-0123456789abcdef",
      },
    });
    await run(FLAGS, c.deps, ROOT, [
      leak("globalkey-0123456789abcdef legacytok-0123456789abcdef"),
    ]);
    const out = c.lines.join("\n");
    expect(out).not.toContain("globalkey-0123456789abcdef");
    expect(out).not.toContain("legacytok-0123456789abcdef");
  });

  it("does not echo a stray positional argument (a pasted token) in the args error", async () => {
    const c = core();
    expect(
      await run([...FLAGS, "pastedSecretValue"], c.deps, ROOT, [noop]),
    ).toBe(1);
    expect(c.lines.join("\n")).not.toContain("pastedSecretValue");
  });
});

describe("adversarial: --name and state", () => {
  it("--name=<x> reads <x>'s state, not open-bus's", async () => {
    const c = core({
      files: {
        [STATE]: JSON.stringify({
          host: "bus.example.com",
          ownerEmail: "o@example.com",
          accountId: "acct-of-open-bus",
          completed: ["prereqs", "deploy"],
        }),
      },
    });
    const flags = ["--name=other", "--host", "o.example.com"];
    await run(
      [...flags, "--owner-email", "x@example.com", "--json"],
      c.deps,
      ROOT,
      [noop],
    );
    const other = JSON.parse(c.files.get(statePath(HOME, "other")) ?? "{}");
    expect(other.accountId).toBeUndefined();
    expect(other.completed).toEqual(["a"]);
  });

  it("a repeated --name reads and writes the same instance", async () => {
    const c = core({
      files: {
        [statePath(HOME, "a")]: JSON.stringify({ accountId: "acct-a" }),
      },
    });
    await run(["--name", "a", "--name", "b", ...FLAGS.slice(2)], c.deps, ROOT, [
      noop,
    ]);
    const b = JSON.parse(c.files.get(statePath(HOME, "b")) ?? "{}");
    expect(b.accountId).toBeUndefined();
  });

  it("a state file holding a JSON string is reported, not thrown", async () => {
    const c = core({ files: { [STATE]: '"oops"' } });
    await expect(run(FLAGS, c.deps, ROOT, [noop])).resolves.toBe(1);
    expect(parsed(c.lines).at(-1)).toMatchObject({ status: "error" });
  });

  it("a corrupt state file error names the state file", async () => {
    const c = core({ files: { [STATE]: "{not json" } });
    expect(await run(FLAGS, c.deps, ROOT, [noop])).toBe(1);
    expect(String(parsed(c.lines)[0].message)).toContain("setup-open-bus.json");
  });

  it("a relative HOME does not put state under the working directory", async () => {
    const c = core({ env: { HOME: "relhome" } });
    await run(FLAGS, c.deps, ROOT, [noop]);
    const written = [...c.files.keys()];
    expect(written.length).toBe(1);
    expect(isAbsolute(written[0])).toBe(true);
    expect(written[0]).not.toBe(
      join("relhome", ".openbus/setup-open-bus.json"),
    );
  });
});

describe("adversarial: --check / --json contracts", () => {
  it("--check writes nothing even if a check() writes through ctx.fs", async () => {
    const c = core();
    const sneaky: Step = {
      name: "a",
      check: async (_s, ctx) => {
        ctx.fs.write(`${HOME}/.openbus/x`, "y");
        return "done";
      },
      apply: async () => undefined,
    };
    await run([...FLAGS, "--check"], c.deps, ROOT, [sneaky]).catch(() => {});
    expect(c.files.has(`${HOME}/.openbus/x`)).toBe(false);
  });

  it("--json never prompts, even if a step asks", async () => {
    const c = core({ answers: ["x"] });
    const asks: Step = {
      name: "a",
      check: async () => "todo",
      apply: async (_s, ctx) => {
        await ctx.deps.prompt("value?");
        return undefined;
      },
    };
    await run(FLAGS, c.deps, ROOT, [asks]).catch(() => {});
    expect(c.prompts).toEqual([]);
  });
});

describe("adversarial: prereqs whoami", () => {
  it("a crashed/timed-out whoami is an error, not 'not logged in'", async () => {
    const c = core({
      exec: async () => ({
        code: 124,
        stdout: "",
        stderr: "npm ERR! network request failed ETIMEDOUT",
      }),
    });
    expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(1);
    expect(String(parsed(c.lines)[0].message)).not.toContain(
      "npx wrangler login",
    );
  });

  it("whoami JSON preceded by a wrangler banner still parses", async () => {
    const c = core({
      stdout: `\n ⛅️ wrangler 4.40.0\n───────────\n${JSON.stringify({ loggedIn: true, accounts: [{ id: "acc1", name: "A" }] })}`,
    });
    expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(0);
  });

  it("an account entry without a string id is not accepted as done", async () => {
    const c = core({ stdout: JSON.stringify({ accounts: [{ name: "A" }] }) });
    const code = await run(FLAGS, c.deps, ROOT, [prereqs]);
    expect(code).not.toBe(0);
  });

  it("a null account entry is reported cleanly (no TypeError text)", async () => {
    const c = core({ stdout: JSON.stringify({ accounts: [null] }) });
    await run(FLAGS, c.deps, ROOT, [prereqs]);
    expect(String(parsed(c.lines)[0].message)).not.toMatch(/Cannot read prop/);
  });

  it("human mode lists the account ids when several accounts need --account-id", async () => {
    const c = core({
      stdout: JSON.stringify({
        accounts: [
          { id: "id-one", name: "One" },
          { id: "id-two", name: "Two" },
        ],
      }),
    });
    const human = FLAGS.filter((f) => f !== "--json");
    expect(await run(human, c.deps, ROOT, [prereqs])).toBe(2);
    expect(c.lines.join("\n")).toContain("id-one");
  });
});
