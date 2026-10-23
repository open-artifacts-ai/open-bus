import { describe, expect, it } from "vitest";
import type { Exec } from "../src/cf.ts";
import { run } from "../src/index.ts";
import { prereqs } from "../src/steps/prereqs.ts";
import { core, FLAGS, ROOT } from "./fakes.ts";

const whoami =
  (accounts: { id: string; name: string }[] | null): Exec =>
  async (cmd, args) => {
    if (cmd === "npx" && args.join(" ") === "wrangler whoami --json")
      return accounts
        ? { code: 0, stdout: JSON.stringify({ accounts }), stderr: "" }
        : { code: 1, stdout: "", stderr: "not logged in" };
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
const one = [{ id: "acc1", name: "Mine" }];
const two = [...one, { id: "acc2", name: "Work" }];
const last = (lines: string[]) => JSON.parse(lines.at(-1) as string);

describe("prereqs", () => {
  it("passes with Node 22 and one account, and saves the account id", async () => {
    const c = core({ exec: whoami(one) });
    c.deps.nodeVersion = "22.12.0";
    expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(0);
    expect(last(c.lines)).toMatchObject({ step: "prereqs", status: "ok" });
    expect(c.state().accountId).toBe("acc1");
  });

  it("fails on Node < 22", async () => {
    const c = core({ exec: whoami(one) });
    c.deps.nodeVersion = "20.11.1";
    expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(1);
    expect(last(c.lines).message).toContain("Node 22");
  });

  it("asks the user to run npx wrangler login when whoami has no accounts", async () => {
    for (const accounts of [null, []]) {
      const c = core({ exec: whoami(accounts) });
      c.deps.nodeVersion = "22.12.0";
      expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(2);
      expect(last(c.lines)).toMatchObject({ status: "action_required" });
      expect(last(c.lines).message).toContain("npx wrangler login");
    }
  });

  it("asks for --account-id when several accounts", async () => {
    const c = core({ exec: whoami(two) });
    c.deps.nodeVersion = "22.12.0";
    expect(await run(FLAGS, c.deps, ROOT, [prereqs])).toBe(2);
    const l = last(c.lines);
    expect(l.status).toBe("action_required");
    expect(l.message).toContain("--account-id");
    expect(l.data.accounts).toEqual(two);
  });

  it("takes --account-id when it is reachable, and refuses one that is not", async () => {
    const c = core({ exec: whoami(two) });
    c.deps.nodeVersion = "22.12.0";
    expect(
      await run([...FLAGS, "--account-id", "acc2"], c.deps, ROOT, [prereqs]),
    ).toBe(0);
    expect(c.state().accountId).toBe("acc2");
    const d = core({ exec: whoami(two) });
    d.deps.nodeVersion = "22.12.0";
    expect(
      await run([...FLAGS, "--account-id", "nope"], d.deps, ROOT, [prereqs]),
    ).toBe(2);
  });

  it("rejects an invalid --host or --name before any API call", async () => {
    for (const bad of [
      ["--name", "Bad_Name", "--host", "bus.example.com"],
      ["--name", "ok", "--host", "not a host"],
    ]) {
      let called = false;
      const c = core({
        exec: async () => {
          called = true;
          return { code: 0, stdout: "", stderr: "" };
        },
        fetch: async () => {
          called = true;
          return new Response("{}");
        },
      });
      expect(
        await run(
          [...bad, "--owner-email", "o@example.com", "--json"],
          c.deps,
          ROOT,
          [prereqs],
        ),
      ).toBe(1);
      expect(last(c.lines)).toMatchObject({ step: "args", status: "error" });
      expect(called).toBe(false);
    }
  });
});
