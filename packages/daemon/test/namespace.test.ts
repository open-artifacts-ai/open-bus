import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveNamespace } from "../src/namespace.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ob-ns-"));
const noGit = { gitRemote: () => null, gitRoot: () => null };

describe("namespace resolution", () => {
  it("normalizes the same repo on two machines to one name", () => {
    const dir = tmp();
    for (const url of [
      "git@github.com:Acme/App.git",
      "https://github.com/acme/app.git",
      "ssh://git@github.com/acme/app",
    ]) {
      expect(
        resolveNamespace(dir, { gitRemote: () => url, gitRoot: () => null }),
      ).toEqual({
        namespace: "github.com/acme/app",
        global: false,
        source: "git",
      });
    }
  });

  it("prefers .openbus.json in a parent", () => {
    const root = tmp();
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ namespace: "zeta", global: true }),
    );
    expect(resolveNamespace(deep, noGit)).toEqual({
      namespace: "zeta",
      global: true,
      source: "config",
    });
  });

  it("merges per key, nearest file first", () => {
    const root = tmp();
    const deep = join(root, "a");
    mkdirSync(deep);
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ namespace: "outer", global: true }),
    );
    writeFileSync(
      join(deep, ".openbus.json"),
      JSON.stringify({ namespace: "inner" }),
    );
    expect(resolveNamespace(deep, noGit)).toEqual({
      namespace: "inner",
      global: true,
      source: "config",
    });
  });

  it("canonicalizes a remote-shaped namespace in .openbus.json", () => {
    const root = tmp();
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ namespace: "git@github.com:Acme/App.git" }),
    );
    expect(resolveNamespace(root, noGit).namespace).toBe("github.com/acme/app");
  });

  it("ignores and logs an invalid .openbus.json", () => {
    const root = tmp();
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ namespace: "x", extra: 1 }),
    );
    const log = vi.fn();
    expect(resolveNamespace(root, { ...noGit, log })).toMatchObject({
      source: "cwd",
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it("keeps a config global with a derived namespace", () => {
    const root = tmp();
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ global: true }),
    );
    expect(
      resolveNamespace(root, {
        gitRemote: () => "https://github.com/acme/app",
        gitRoot: () => null,
      }),
    ).toEqual({
      namespace: "github.com/acme/app",
      global: true,
      source: "git",
    });
  });

  it("falls back to the git root name, then the cwd", () => {
    const root = tmp();
    expect(
      resolveNamespace(root, {
        gitRemote: () => null,
        gitRoot: () => "/x/My Repo",
      }),
    ).toEqual({ namespace: "my-repo", global: false, source: "dir" });
    expect(resolveNamespace(join(root), noGit)).toEqual({
      namespace: (root.split("/").pop() as string).toLowerCase(),
      global: false,
      source: "cwd",
    });
  });
});
