import { describe, expect, it } from "vitest";
import { namespaceFrom, normalizeRemote } from "./namespace.js";

describe("normalizeRemote", () => {
  it("makes the same repo equal across machines", () => {
    const forms = [
      "git@github.com:Acme/Widgets.git",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://user:tok@GitHub.com/acme/widgets/",
    ];
    const out = forms.map(normalizeRemote);
    expect(new Set(out)).toEqual(new Set(["github.com/acme/widgets"]));
  });
  it("returns null for local paths and junk", () => {
    for (const u of [
      "/Users/me/repo",
      "../x",
      "file:///tmp/x",
      "",
      "not a url",
    ]) {
      expect(normalizeRemote(u)).toBeNull();
    }
  });
});

describe("namespaceFrom", () => {
  it("prefers the remote", () => {
    expect(
      namespaceFrom({
        remoteUrl: "git@github.com:A/B.git",
        gitRootName: "b",
        cwd: "/x/b",
      }),
    ).toBe("github.com/a/b");
  });
  it("falls back to the git root name, then the cwd basename", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: "Widgets", cwd: "/x/y" }),
    ).toBe("widgets");
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/x/My Repo" }),
    ).toBe("my-repo");
  });
  it("never returns an empty namespace", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: null, cwd: "/" }),
    ).toBe("default");
  });
});
