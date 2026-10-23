import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sandbox, script, write } from "./stubs.ts";

const BASE = "https://staging.open-bus.ai";
// curl stub: prints $CURL_HEADERS when -D - is given, body to -o file or stdout.
const curl = `
out=""; dump=0; args=("$@")
for ((i=0;i<$#;i++)); do case "\${args[i]}" in -o) out="\${args[i+1]}";; -D) dump=1;; esac; done
[ $dump = 1 ] && cat "$CURL_HEADERS"
if [ -n "$out" ] && [ "$out" != /dev/null ]; then cat "$CURL_BODY" > "$out"
elif [ $dump = 0 ]; then cat "$CURL_BODY"; fi
true`;

function smoke(check: string, body: string, version?: string) {
  const sb = sandbox({ curl });
  write(join(sb.dir, "h"), "");
  write(join(sb.dir, "b"), body);
  const args = ["bash", script("staging-smoke.sh"), check, BASE];
  if (version !== undefined) args.push(version);
  const r = sb.run(args, {
    env: {
      CURL_HEADERS: join(sb.dir, "h"),
      CURL_BODY: join(sb.dir, "b"),
      SMOKE_WAIT_S: "0",
    },
  });
  return { ...r, sb };
}

describe("staging-smoke.sh", () => {
  it("healthz passes when /healthz reports a version", () => {
    const r = smoke("healthz", '{"version":"0.0.0-abc1234"}');
    expect(r.code).toBe(0);
    expect(r.sb.log()[0]).toContain(`${BASE}/healthz`);
  });
  it("healthz fails when /healthz reports no version", () => {
    const r = smoke("healthz", '{"ok":true}');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("::error::");
  });
  it("healthz with an expected version passes on an exact match", () => {
    expect(smoke("healthz", '{"version":"0.1.0"}', "0.1.0").code).toBe(0);
  });
  it("healthz with an expected version fails on a mismatch", () => {
    const r = smoke("healthz", '{"version":"0.0.9"}', "0.1.0");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("expected version 0.1.0");
  });
  it("healthz polls until the expected version is served", () => {
    // Serves b1, then b2, then b3 (the last repeats): propagation lag.
    const seq = `n=$(cat "$DIR/n" 2>/dev/null || echo 1); f="$DIR/b$n"; [ -f "$f" ] || f="$DIR/b3"; cat "$f"; echo $((n+1)) > "$DIR/n"`;
    const sb = sandbox({ curl: seq, sleep: "true" });
    write(join(sb.dir, "b1"), '{"version":"0.1.0-old"}');
    write(join(sb.dir, "b2"), '{"version":"0.1.0-old"}');
    write(join(sb.dir, "b3"), '{"version":"0.1.0-new"}');
    const r = sb.run(
      ["bash", script("staging-smoke.sh"), "healthz", BASE, "0.1.0-new"],
      { env: { DIR: sb.dir, SMOKE_WAIT_S: "60", SMOKE_INTERVAL_S: "0" } },
    );
    expect(r.code).toBe(0);
    expect(sb.log().filter((l) => l.startsWith("curl")).length).toBe(3);
  });
  it("healthz failures print an error line", () => {
    expect(smoke("healthz", "nope").out).toContain("::error::");
  });
  const DEVICE = JSON.stringify({
    device_code: "SECRET-device-code",
    user_code: "ABCD-2345",
    verification_uri: `${BASE}/approve`,
    expires_in: 600,
    interval: 5,
  });
  const dev = (over: Record<string, unknown>) =>
    JSON.stringify({ ...JSON.parse(DEVICE), ...over });
  it("device check passes on a well-formed user_code and never prints device_code", () => {
    const r = smoke("device", DEVICE);
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("SECRET-device-code");
    const call = r.sb.log()[0] ?? "";
    expect(call).toContain(`${BASE}/device/code`);
    expect(call).toContain("machine_label");
  });
  it.each([
    ["not json", "nope"],
    ["empty object", "{}"],
    ["lowercase user_code", dev({ user_code: "abcd-2345" })],
    ["ambiguous characters", dev({ user_code: "ABCD-0O1I" })],
    ["no dash", dev({ user_code: "ABCD2345" })],
    ["wrong expires_in", dev({ expires_in: 900 })],
    ["wrong interval", dev({ interval: 1 })],
    ["no device_code", dev({ device_code: undefined })],
  ])("device check fails on %s", (_n, body) => {
    const r = smoke("device", body);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("::error::");
    expect(r.out + r.err).not.toContain("SECRET-device-code");
  });
  it("refuses an unknown check", () => {
    expect(smoke("robots", "x").code).toBe(2);
  });
});
