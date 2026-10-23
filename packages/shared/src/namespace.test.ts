import { describe, expect, it } from "vitest";
import {
  NamespaceSchema,
  namespaceFrom,
  normalizeRemote,
} from "./namespace.js";

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

describe("normalizeRemote hardening", () => {
  it("A: `.git/` equals the plain form", () => {
    expect(normalizeRemote("git@github.com:acme/widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeRemote("https://github.com/acme/widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
  });
  it("B: scp and https agree on dot segments", () => {
    expect(normalizeRemote("git@github.com:acme/./widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(normalizeRemote("git@github.com:acme/./widgets")).toBe(
      normalizeRemote("https://github.com/acme/./widgets"),
    );
  });
  it("C: single-label, IP, localhost, git+ssh and ~user remotes normalize", () => {
    const want: Record<string, string> = {
      "git@gitserver:team/widgets.git": "gitserver/team/widgets",
      "ssh://git@10.0.0.5/team/widgets.git": "10.0.0.5/team/widgets",
      "https://localhost:3000/team/widgets": "localhost/team/widgets",
      "git+ssh://git@github.com/acme/widgets.git": "github.com/acme/widgets",
      "ssh://git@github.com/~alice/widgets.git": "github.com/~alice/widgets",
    };
    for (const [r, w] of Object.entries(want))
      expect(normalizeRemote(r), r).toBe(w);
  });
  it("C: a bare `word:path` or a Windows path is not a remote", () => {
    for (const r of ["foo:bar", "C:\\Users\\x", "C:/x/y"]) {
      expect(normalizeRemote(r), r).toBeNull();
    }
  });
  it("C2: same-named repos on one internal host do not collide", () => {
    const a = namespaceFrom({
      remoteUrl: "git@gitserver:team-a/widgets.git",
      gitRootName: "widgets",
      cwd: "/w",
    });
    const b = namespaceFrom({
      remoteUrl: "git@gitserver:team-b/widgets.git",
      gitRootName: "widgets",
      cwd: "/w",
    });
    expect(a).not.toBe(b);
  });
  it("D: long paths are hashed, not truncated into collisions", () => {
    const stem = `gitlab.com/${"group/".repeat(20)}`;
    const a = normalizeRemote(`https://${stem}service-alpha`);
    const b = normalizeRemote(`https://${stem}service-beta`);
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a?.length).toBe(128);
    expect(a).toBe(
      normalizeRemote(
        `git@gitlab.com:${stem.slice("gitlab.com/".length)}service-alpha.git`,
      ),
    );
    expect(a).toMatch(/-[0-9a-f]{8}$/);
  });
  it("E/F: port is dropped and the path is lowercased, on purpose", () => {
    // Intentional (spec: same repo on two machines is one namespace): ports and
    // case differ across clones of one repo, so they are not part of identity.
    expect(normalizeRemote("https://git.example.com:8443/team/app")).toBe(
      normalizeRemote("https://git.example.com/team/app"),
    );
    expect(normalizeRemote("git@git.example.com:team/App.git")).toBe(
      normalizeRemote("git@git.example.com:team/app.git"),
    );
  });
});

describe("namespaceFrom fallback hardening", () => {
  it("G: Windows cwd uses its basename", () => {
    expect(
      namespaceFrom({
        remoteUrl: null,
        gitRootName: null,
        cwd: "C:\\Users\\alice\\widgets",
      }),
    ).toBe("widgets");
  });
  it("H: diacritics fold; other non-ASCII names get a stable distinct hash", () => {
    expect(
      namespaceFrom({ remoteUrl: null, gitRootName: "Café Projet", cwd: "/x" }),
    ).toBe("cafe-projet");
    const a = namespaceFrom({
      remoteUrl: null,
      gitRootName: "проект",
      cwd: "/home/u/проект",
    });
    const b = namespaceFrom({
      remoteUrl: null,
      gitRootName: "프로젝트",
      cwd: "/home/u/프로젝트",
    });
    expect(a).toMatch(/^dir-[0-9a-f]{8}$/);
    expect(b).toMatch(/^dir-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    expect(a).toBe(
      namespaceFrom({
        remoteUrl: null,
        gitRootName: null,
        cwd: "/elsewhere/проект",
      }),
    );
  });
});

describe("NamespaceSchema hardening", () => {
  it("I: rejects C1, bidi, zero-width, BOM and line separators", () => {
    for (const s of [
      "a\u200b",
      "a\u200d",
      "a\u200e",
      "a\u202a",
      "a\u202e",
      "a\u2066",
      "a\u2069",
      "a\u2060",
      "a\u0085",
      "a\u009f",
      "a\u2028",
      "a\u2029",
      "a\ufeff",
      "a\u0000",
      "a\u007f",
    ]) {
      expect(NamespaceSchema.safeParse(s).success, JSON.stringify(s)).toBe(
        false,
      );
    }
  });
  it("J: a remote-shaped namespace is normalized; anything else is verbatim", () => {
    expect(NamespaceSchema.parse("https://github.com/Acme/Widgets.git")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("git@github.com:Acme/Widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("github.com/acme/widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("My Team")).toBe("My Team");
  });
  it("J: a scheme-less host.tld/owner/repo is normalized like its https form", () => {
    expect(NamespaceSchema.parse("GitHub.com/Acme/Widgets")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("GitHub.com/Acme/Widgets.git/")).toBe(
      "github.com/acme/widgets",
    );
    expect(NamespaceSchema.parse("My/Team")).toBe("My/Team");
    expect(NamespaceSchema.parse("Acme Widgets.com/x")).toBe(
      "Acme Widgets.com/x",
    );
  });
});
