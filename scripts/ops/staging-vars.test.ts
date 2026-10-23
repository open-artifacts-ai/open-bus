import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, sandbox } from "../ci/stubs.ts";

const SCRIPT = join(root, "scripts/ops/staging-vars.sh");
const STATE = {
  name: "open-bus-staging",
  ownerEmail: "o@example.com",
  teamDomain: "team.cloudflareaccess.com",
  accessClientId: "client-id-123",
  accessAppId: "app-id-should-not-be-set",
};

function run(state: object | null, gh = "") {
  const sb = sandbox({ gh });
  const home = join(sb.dir, "home");
  if (state) {
    mkdirSync(join(home, ".openbus"), { recursive: true });
    writeFileSync(
      join(home, ".openbus", "setup-open-bus-staging.json"),
      JSON.stringify(state),
    );
  }
  const r = sb.run(["bash", SCRIPT], { env: { HOME: home } });
  return { ...r, calls: sb.log() };
}

describe("staging-vars.sh", () => {
  it("sets the three STAGING_* vars from the state file", () => {
    const r = run(STATE);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([
      "gh variable set STAGING_OWNER_EMAIL --body o@example.com",
      "gh variable set STAGING_ACCESS_TEAM_DOMAIN --body team.cloudflareaccess.com",
      "gh variable set STAGING_ACCESS_CLIENT_ID --body client-id-123",
    ]);
  });
  it("prints only the variable names", () => {
    const r = run(STATE);
    for (const n of [
      "STAGING_OWNER_EMAIL",
      "STAGING_ACCESS_TEAM_DOMAIN",
      "STAGING_ACCESS_CLIENT_ID",
    ])
      expect(r.out).toContain(n);
    for (const v of [
      "o@example.com",
      "team.cloudflareaccess.com",
      "client-id-123",
    ])
      expect(r.out + r.err).not.toContain(v);
  });
  it("fails without calling gh when the state file is missing", () => {
    const r = run(null);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("pnpm -s ob:setup");
    expect(r.calls).toEqual([]);
  });
  it("fails without calling gh when a value is missing", () => {
    const { accessClientId: _, ...partial } = STATE;
    const r = run(partial);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("accessClientId");
    expect(r.calls).toEqual([]);
  });
  it("stops and reports the name when gh fails, without echoing its output", () => {
    const r = run(STATE, "echo 'boom client-id-123' >&2; exit 1");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("STAGING_OWNER_EMAIL");
    expect(r.out + r.err).not.toContain("client-id-123");
    expect(r.calls).toHaveLength(1);
  });
});
