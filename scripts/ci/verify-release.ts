// After a release deploys: prod /healthz and, when --site-url is given, the
// landing's ob-version meta must both show the released version, else open a
// `blocker` issue and fail. The prod and site hosts come from the caller (06
// integration wires them from the repo's variables); nothing is hardcoded.
// It also checks npm's latest `open-bus` and, with --site-url, that llms.txt
// mentions `npx @open-bus/cli`; --skip-npm / --skip-llms skip those two for releases
// before the CLI is published (C10) or the landing serves llms.txt (D7).
// Usage: node --experimental-strip-types scripts/ci/verify-release.ts --tag vX.Y.Z --repo owner/name --prod-url URL [--site-url URL] [--skip-npm] [--skip-llms]
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 180_000;
const NPM_TIMEOUT_MS = 600_000;
const INTERVAL_MS = 10_000;

const SEMVER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?";
const SEMVER_RE = new RegExp(`^${SEMVER}$`);
const TAG_RE = new RegExp(`^v${SEMVER}$`);
const NOT_LIVE_RE = new RegExp(`^Release v(${SEMVER}) not live(?::|$)`);

/** Remote text may only enter a message as a validated semver. */
const safeVersion = (v: unknown): string =>
  typeof v === "string" && SEMVER_RE.test(v) ? v : "no valid version";

const triple = (v: string) =>
  v.split("-")[0]?.split(".").map(Number) as [number, number, number];
function cmp(a: string, b: string): number {
  const [x, y] = [triple(a), triple(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d) return d;
  }
  return 0;
}

export type ExecResult = { code: number; stdout: string; stderr: string };
export type Exec = (
  cmd: string,
  args: string[],
) => ExecResult | Promise<ExecResult>;

type Deps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/** The `ob-version` meta tag's content, whatever the attribute order. */
function metaVersion(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']ob-version["']/i.test(tag)) continue;
    return tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
  }
  return null;
}

async function healthVersion(
  d: Deps,
  base: string,
  label: string,
  want: string,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(`${base}/healthz`);
  } catch {
    return `${label} healthz unreachable`;
  }
  if (!res.ok) return `${label} healthz answered HTTP ${res.status}`;
  let version: unknown;
  try {
    version = ((await res.json()) as { version?: unknown }).version;
  } catch {
    return `${label} healthz did not answer JSON`;
  }
  return version === want
    ? undefined
    : `${label} healthz reports ${safeVersion(version)}, expected ${want}`;
}

async function landingVersion(
  d: Deps,
  siteUrl: string,
  want: string,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(siteUrl);
  } catch {
    return "landing unreachable";
  }
  if (!res.ok) return `landing answered HTTP ${res.status}`;
  const v = metaVersion(await res.text());
  if (v === null) return "landing has no ob-version meta tag";
  return v === want
    ? undefined
    : `landing ob-version is ${safeVersion(v)}, expected ${want}`;
}

const NPM_LATEST = "https://registry.npmjs.org/open-bus/latest";

async function npmVersion(d: Deps, want: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(`${NPM_LATEST}?t=${d.now()}`, { cache: "no-store" });
  } catch {
    return "npm registry unreachable";
  }
  if (!res.ok) return `npm registry answered HTTP ${res.status}`;
  let version: unknown;
  try {
    version = ((await res.json()) as { version?: unknown }).version;
  } catch {
    return "npm registry did not answer JSON";
  }
  return version === want
    ? undefined
    : `npm latest open-bus is ${safeVersion(version)}, expected ${want}`;
}

async function llmsMentionsNpx(
  d: Deps,
  siteUrl: string,
): Promise<string | undefined> {
  let res: Response;
  try {
    res = await d.fetch(new URL("llms.txt", siteUrl).href);
  } catch {
    return "llms.txt unreachable";
  }
  if (!res.ok) return `llms.txt answered HTTP ${res.status}`;
  return (await res.text()).includes("npx @open-bus/cli")
    ? undefined
    : "llms.txt does not mention npx @open-bus/cli";
}

/** Polls (up to 3 minutes by default) until every target shows the tag's version. */
export async function verifyRelease(
  o: Deps & {
    tag: string;
    prodUrl: string;
    siteUrl?: string;
    skipNpm?: boolean;
    skipLlms?: boolean;
    timeoutMs?: number;
    npmTimeoutMs?: number;
    intervalMs?: number;
  },
): Promise<{ ok: boolean; problems: string[] }> {
  if (!TAG_RE.test(o.tag))
    throw new Error(`tag must look like vX.Y.Z, got ${JSON.stringify(o.tag)}`);
  const want = o.tag.slice(1);
  const checks: [string, () => Promise<string | undefined>][] = [
    ["prod", () => healthVersion(o, o.prodUrl, "prod", want)],
    ...(o.siteUrl
      ? ([["landing", () => landingVersion(o, o.siteUrl as string, want)]] as [
          string,
          () => Promise<string | undefined>,
        ][])
      : []),
    ...(o.skipNpm
      ? []
      : ([["npm", () => npmVersion(o, want)]] as [
          string,
          () => Promise<string | undefined>,
        ][])),
    ...(o.siteUrl && !o.skipLlms
      ? ([["llms", () => llmsMentionsNpx(o, o.siteUrl as string)]] as [
          string,
          () => Promise<string | undefined>,
        ][])
      : []),
  ];
  const start = o.now();
  // npm's registry can lag a publish by minutes, so it polls on its own, longer clock.
  const limit = (name: string) =>
    start +
    (name === "npm"
      ? (o.npmTimeoutMs ?? NPM_TIMEOUT_MS)
      : (o.timeoutMs ?? TIMEOUT_MS));
  const interval = o.intervalMs ?? INTERVAL_MS;
  const last = new Map<string, string>();
  const gaveUp = new Set<string>();
  let pending = checks;
  for (;;) {
    const next: typeof checks = [];
    for (const c of pending) {
      const problem = await c[1]();
      if (!problem) last.delete(c[0]);
      else {
        last.set(c[0], problem);
        if (o.now() + interval > limit(c[0])) gaveUp.add(c[0]);
        else next.push(c);
      }
    }
    pending = next;
    if (!pending.length)
      return gaveUp.size
        ? {
            ok: false,
            problems: checks
              .filter((c) => gaveUp.has(c[0]))
              .map((c) => last.get(c[0]) as string),
          }
        : { ok: true, problems: [] };
    await o.sleep(interval);
  }
}

async function gh(exec: Exec, args: string[]): Promise<string> {
  const r = await exec("gh", args);
  if (r.code !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`,
    );
  return r.stdout;
}

/** Opens (or comments on) the `blocker` issue "Release vX.Y.Z not live: <what>". */
export async function reportNotLive(o: {
  exec: Exec;
  repo: string;
  tag: string;
  problems: string[];
}): Promise<void> {
  if (!TAG_RE.test(o.tag))
    throw new Error(`tag must look like vX.Y.Z, got ${JSON.stringify(o.tag)}`);
  const prefix = `Release ${o.tag} not live:`;
  const clean = (p: string) => p.replace(/[^\w .,;:()'-]/g, "?").slice(0, 200);
  const title = `${prefix} ${o.problems.map(clean).join("; ")}`;
  const body = [
    `${o.tag} was released and deployed, but the live checks do not show it:`,
    "",
    ...o.problems.map((p) => `- ${p}`),
  ].join("\n");
  const existing: { number: number; title: string }[] = JSON.parse(
    await gh(o.exec, [
      "issue",
      "list",
      "--repo",
      o.repo,
      "--label",
      "blocker",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "50",
    ]),
  );
  const same = existing.find((i) => i.title.startsWith(prefix));
  if (same) {
    await gh(o.exec, [
      "issue",
      "comment",
      String(same.number),
      "--repo",
      o.repo,
      "--body",
      `Still not live:\n\n${body}`,
    ]);
    return;
  }
  await gh(o.exec, [
    "label",
    "create",
    "blocker",
    "--repo",
    o.repo,
    "--force",
    "--color",
    "B60205",
    "--description",
    "A release or deploy is stuck",
  ]);
  await gh(o.exec, [
    "issue",
    "create",
    "--repo",
    o.repo,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "blocker",
  ]);
}

/** Closes the open "Release vX not live" issues for this tag or an older one, once this tag is verified live. */
export async function closeNotLive(o: {
  exec: Exec;
  repo: string;
  tag: string;
}): Promise<number[]> {
  if (!TAG_RE.test(o.tag))
    throw new Error(`tag must look like vX.Y.Z, got ${JSON.stringify(o.tag)}`);
  const open: { number: number; title: string }[] = JSON.parse(
    await gh(o.exec, [
      "issue",
      "list",
      "--repo",
      o.repo,
      "--label",
      "blocker",
      "--state",
      "open",
      "--json",
      "number,title",
      "--limit",
      "50",
    ]),
  );
  const closed: number[] = [];
  for (const i of open) {
    const v = NOT_LIVE_RE.exec(i.title)?.[1];
    if (!v || cmp(v, o.tag.slice(1)) > 0) continue;
    await gh(o.exec, [
      "issue",
      "close",
      String(i.number),
      "--repo",
      o.repo,
      "--comment",
      `${o.tag} verified live. Closing.`,
    ]);
    closed.push(i.number);
  }
  return closed;
}

const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

async function main(argv: string[]) {
  const arg = (f: string) => {
    const i = argv.indexOf(f);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const tag = arg("--tag");
  const repo = arg("--repo");
  const prodUrl = arg("--prod-url");
  if (!tag || !repo || !prodUrl) {
    console.error(
      "usage: verify-release.ts --tag vX.Y.Z --repo owner/name --prod-url URL [--site-url URL] [--skip-npm] [--skip-llms]",
    );
    return 2;
  }
  const r = await verifyRelease({
    tag,
    prodUrl,
    siteUrl: arg("--site-url"),
    skipNpm: argv.includes("--skip-npm"),
    skipLlms: argv.includes("--skip-llms"),
    fetch,
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: Date.now,
  });
  if (r.ok) {
    console.log(`${tag} is live`);
    const closed = await closeNotLive({ exec: realExec, repo, tag });
    if (closed.length)
      console.log(`closed not-live issues: ${closed.join(", ")}`);
    return 0;
  }
  for (const p of r.problems) console.error(`not live: ${p}`);
  await reportNotLive({ exec: realExec, repo, tag, problems: r.problems });
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    },
  );
