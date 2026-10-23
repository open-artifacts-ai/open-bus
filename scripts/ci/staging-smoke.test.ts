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
    env: { CURL_HEADERS: join(sb.dir, "h"), CURL_BODY: join(sb.dir, "b") },
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
  it("healthz failures print an error line", () => {
    expect(smoke("healthz", "nope").out).toContain("::error::");
  });
  it("refuses an unknown check", () => {
    expect(smoke("robots", "x").code).toBe(2);
  });
});
