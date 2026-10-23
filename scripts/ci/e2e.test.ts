import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script, write } from "./stubs.ts";

const pnpm = 'echo "PW_DIR=$PLAYWRIGHT_HTML_OUTPUT_DIR" >> "$STUB_LOG"';
const stubs = { pnpm, sudo: '"$@"' };

/** Fixture package dirs: a package.json each, and a pinned Playwright for version. */
function fixtures(dir: string) {
  const dashboard = join(dir, "apps", "dashboard");
  const ui = join(dir, "packages", "ui");
  const landing = join(dir, "apps", "landing");
  for (const [d, name] of [
    [dashboard, "@ob/dashboard"],
    [ui, "@ob/ui"],
    [landing, "@ob/landing"],
  ] as const)
    write(
      join(d, "package.json"),
      JSON.stringify({ name, scripts: { "test:browser": "x" } }),
    );
  write(
    join(dashboard, "node_modules/@playwright/test/package.json"),
    JSON.stringify({ version: "9.9.9" }),
  );
  return { E2E_DASHBOARD: dashboard, E2E_UI: ui, E2E_LANDING: landing };
}

describe("e2e.sh", () => {
  it("version writes the dashboard's Playwright version", () => {
    const sb = sandbox(stubs);
    const out = join(sb.dir, "out");
    write(out, "");
    const r = sb.run(["bash", script("e2e.sh"), "version"], {
      env: { GITHUB_OUTPUT: out, ...fixtures(sb.dir) },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("playwright=9.9.9\n");
  });
  it("install pins chromium and webkit with OS deps", () => {
    const sb = sandbox(stubs);
    const r = sb.run(["bash", script("e2e.sh"), "install"], {
      // No apt config dir: the test never writes the runner's real /etc/apt.
      env: { ...fixtures(sb.dir), APT_CONF_DIR: "" },
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toContain(
      "pnpm --filter @ob/dashboard exec playwright install --with-deps chromium webkit",
    );
  });
  /** A fake root fs for apt: conf dir, archives, a deb822 sources file, the deb cache. */
  function aptWorld() {
    const d = mkdtempSync(join(tmpdir(), "apt-"));
    const conf = join(d, "conf");
    const archives = join(d, "archives");
    const debs = join(d, "debs");
    const sources = join(d, "ubuntu.sources");
    for (const x of [conf, archives]) write(join(x, ".keep"), "");
    write(
      sources,
      "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n",
    );
    const env = {
      APT_CONF_DIR: conf,
      APT_ARCHIVES: archives,
      APT_SOURCES: sources,
      APT_DEBS_DIR: debs,
    };
    return { d, conf, archives, debs, sources, env };
  }
  // pkill/dpkg/sleep stubs: recovery is logged, never run for real.
  const recover = { sudo: '"$@"', pkill: "true", dpkg: "true", sleep: "true" };

  it("install bounds apt, and on a stalled attempt recovers and retries from archive.ubuntu.com", () => {
    const w = aptWorld();
    // timeout stub: fails twice, then runs the command.
    const timeout = `n=$(cat "$DIR/n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$DIR/n"; [ $n -ge 3 ] || exit 124; shift; "$@"`;
    const sb = sandbox({ ...stubs, ...recover, timeout });
    const r = sb.run(["bash", script("e2e.sh"), "install"], {
      env: { ...fixtures(sb.dir), ...w.env, DIR: sb.dir },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("attempt 2 failed or timed out");
    expect(r.out).toContain("attempt 3: retrying from archive.ubuntu.com");
    const conf = readFileSync(join(w.conf, "99openbus-timeouts"), "utf8");
    expect(conf).toContain('Acquire::http::Timeout "30";');
    expect(conf).toContain('DPkg::Lock::Timeout "60";');
    expect(conf).toContain(
      'Binary::apt::APT::Keep-Downloaded-Packages "true";',
    );
    expect(readFileSync(w.sources, "utf8")).toContain(
      "URIs: http://archive.ubuntu.com/ubuntu/",
    );
    // The stuck apt is killed and dpkg repaired before each retry.
    expect(sb.log()).toContain("pkill -x apt-get");
    expect(sb.log()).toContain("dpkg --configure -a");
  }, 30_000);
  it("install seeds apt from cached debs and saves them after a green install", () => {
    const w = aptWorld();
    write(join(w.debs, "libwoff1.deb"), "x");
    // The install "downloads" one more deb into the archives.
    const timeout = `shift; touch "$ARCH/libnew.deb"; "$@"`;
    const sb = sandbox({ ...stubs, ...recover, timeout });
    const r = sb.run(["bash", script("e2e.sh"), "install"], {
      env: { ...fixtures(sb.dir), ...w.env, ARCH: w.archives },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("seeded 1 cached .debs");
    expect(readFileSync(join(w.archives, "libwoff1.deb"), "utf8")).toBe("x");
    expect(readFileSync(join(w.debs, "libnew.deb"), "utf8")).toBe("");
  }, 30_000);
  it("install gives up after three stalled attempts", () => {
    const w = aptWorld();
    const sb = sandbox({ ...stubs, ...recover, timeout: "exit 124" });
    const r = sb.run(["bash", script("e2e.sh"), "install"], {
      env: { ...fixtures(sb.dir), ...w.env },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::playwright install failed 3 times");
  }, 30_000);
  it("hosts adds the line once", () => {
    const sb = sandbox({ sudo: '"$@"' });
    const hosts = join(sb.dir, "hosts");
    write(hosts, "127.0.0.1 localhost\n");
    for (let i = 0; i < 2; i++)
      expect(
        sb.run(["bash", script("e2e.sh"), "hosts"], {
          env: { HOSTS_FILE: hosts },
        }).code,
      ).toBe(0);
    expect(readFileSync(hosts, "utf8")).toBe(
      "127.0.0.1 localhost\n127.0.0.1 app.localhost content.localhost\n",
    );
  });
  it("mock and real run their suites into separate reports", () => {
    const mock = sandbox(stubs);
    const r1 = mock.run(["bash", script("e2e.sh"), "mock"], {
      env: fixtures(mock.dir),
    });
    expect(r1.code).toBe(0);
    expect(mock.log()).toEqual([
      "pnpm --filter @ob/dashboard exec playwright test --reporter=list,html",
      "PW_DIR=playwright-report/mock",
    ]);
    const real = sandbox(stubs);
    const realEnv = fixtures(real.dir);
    write(join(realEnv.E2E_DASHBOARD, "playwright.real.config.ts"), "");
    const r2 = real.run(["bash", script("e2e.sh"), "real"], {
      env: realEnv,
    });
    expect(r2.code).toBe(0);
    expect(real.log()).toEqual([
      "pnpm --filter @ob/dashboard exec playwright test -c playwright.real.config.ts",
      "PW_DIR=playwright-report/real",
    ]);
  });
  it("ui runs the @ob/ui real-browser checks (axe contrast, focus)", () => {
    const sb = sandbox(stubs);
    const r = sb.run(["bash", script("e2e.sh"), "ui"], {
      env: fixtures(sb.dir),
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toEqual(["pnpm --filter @ob/ui test:browser", "PW_DIR="]);
  });
  it("landing runs the landing checks", () => {
    const sb = sandbox(stubs);
    const r = sb.run(["bash", script("e2e.sh"), "landing"], {
      env: fixtures(sb.dir),
    });
    expect(r.code).toBe(0);
    expect(sb.log()).toContain("pnpm --filter @ob/landing test:browser");
  });
  it("skips cleanly when the target package is not on disk yet", () => {
    const sb = sandbox(stubs);
    const missing = join(sb.dir, "missing");
    for (const arg of ["version", "install", "mock", "real", "ui", "landing"]) {
      const r = sb.run(["bash", script("e2e.sh"), arg], {
        env: {
          E2E_DASHBOARD: missing,
          E2E_UI: missing,
          E2E_LANDING: missing,
          GITHUB_OUTPUT: join(sb.dir, "out"),
        },
      });
      expect(r.code, arg).toBe(0);
      expect(r.err).toContain("skip:");
      expect(sb.log()).toEqual([]);
    }
  });
  it("skips the dashboard suites until @playwright/test is installed", () => {
    const sb = sandbox(stubs);
    const dashboard = join(sb.dir, "dashboard");
    write(join(dashboard, "package.json"), JSON.stringify({ name: "x" }));
    for (const arg of ["version", "install", "mock", "real"]) {
      const r = sb.run(["bash", script("e2e.sh"), arg], {
        env: { E2E_DASHBOARD: dashboard, GITHUB_OUTPUT: join(sb.dir, "out") },
      });
      expect(r.code, arg).toBe(0);
      expect(r.err).toContain("no @playwright/test");
    }
    expect(sb.log()).toEqual([]);
  });
  it("real skips until the dashboard has playwright.real.config.ts", () => {
    const sb = sandbox(stubs);
    const env = fixtures(sb.dir);
    const r = sb.run(["bash", script("e2e.sh"), "real"], { env });
    expect(r.code).toBe(0);
    expect(r.err).toContain("no playwright.real.config.ts");
    expect(sb.log()).toEqual([]);
  });
  it("skips ui and landing until they have a test:browser script", () => {
    const sb = sandbox(stubs);
    const pkg = join(sb.dir, "pkg");
    write(join(pkg, "package.json"), JSON.stringify({ name: "x" }));
    for (const arg of ["ui", "landing"]) {
      const r = sb.run(["bash", script("e2e.sh"), arg], {
        env: { E2E_UI: pkg, E2E_LANDING: pkg },
      });
      expect(r.code, arg).toBe(0);
      expect(r.err).toContain("no test:browser script");
    }
    expect(sb.log()).toEqual([]);
  });
  it("rejects an unknown step", () => {
    const sb = sandbox(stubs);
    expect(sb.run(["bash", script("e2e.sh"), "deploy"]).code).toBe(2);
  });
});
