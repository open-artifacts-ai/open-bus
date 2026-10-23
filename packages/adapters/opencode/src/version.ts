export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The first OpenCode whose `session.prompt` honours an optional `id`: a
 * repeated id returns the record already admitted instead of a second prompt.
 * Every v2 tag has it (anomalyco/opencode v2.0.0, packages/core/src/session/
 * session.ts `admission.reconcile`); the 1.x line has no such API.
 */
export const MIN_PROMPT_ID_VERSION = "2.0.0";

const SEMVER = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;

/** The first `x.y.z[-pre]` in `opencode --version` output, e.g. "opencode v2.0.32". */
export function parseOpencodeVersion(out: string): string | undefined {
  return SEMVER.exec(out)?.[0];
}

/** The installed OpenCode's version, or undefined if it cannot be read. */
export async function opencodeVersion(exec: Exec): Promise<string | undefined> {
  try {
    const r = await exec("opencode", ["--version"]);
    if (r.code !== 0) return undefined;
    return parseOpencodeVersion(r.stdout) ?? parseOpencodeVersion(r.stderr);
  } catch {
    return undefined;
  }
}

/** -1, 0 or 1; a prerelease sorts before its release. Undefined if unparsable. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return undefined;
  for (const i of [1, 2, 3]) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (Boolean(x[4]) === Boolean(y[4])) return 0;
  return x[4] ? -1 : 1;
}

export function supportsPromptId(version: string | undefined): boolean {
  if (version === undefined) return false;
  return (compareVersions(version, MIN_PROMPT_ID_VERSION) ?? -1) >= 0;
}
