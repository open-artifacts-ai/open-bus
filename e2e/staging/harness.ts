// The staging scenario harness (06-integration I7).
//
// `machine(label)` is one machine to the hub: a fresh OPENBUS_HOME, logged in
// through the real device flow (packages/cli login) and approved over REST with
// a stored browser session, then a real daemon (packages/daemon runDaemon) on
// its own local socket. `machine.session(...)` is a fake harness session that
// speaks the adapter socket contract (packages/ipc connectDaemon).
//
// The daemon runs in-process with the seams its own tests use: attestation is
// the real `attest()` fed harness evidence (a fake ~/.claude/sessions dir, an
// OpenCode presence set, Pi start times), and delivery goes through the
// `transports` seam. The fake transport records every call and accepts it
// unconditionally: deciding whether a closed session may be woken is the
// daemon's job, so a call for a closed session is a finding, never hidden.
//
// Between each daemon and the hub sits a WebSocket tap. It forwards frames
// verbatim and records every request with the hub's reply (matched by frame
// id, read by string), receipt_update frames and close codes, none of which the
// daemon surfaces. It can also sever the link without a close frame, hold the
// daemon's acks, and inject a raw frame on the machine's own link.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  attest,
  type Daemon,
  type DeliverFn,
  type Mail,
  readConfig,
  resolveNamespace,
  runDaemon,
} from "@ob/daemon";
import {
  connectDaemon,
  type DaemonClient,
  type DaemonFrame,
  Hello,
  type Kind,
} from "@ob/ipc";
import {
  ApprovalBodySchema,
  type ClientFrame,
  ClientFrameSchema,
  CONFIG_FILE,
  CSRF_HEADER,
  CSRF_VALUE,
  DeviceCodeResponseSchema,
  encodeFrame,
  OpenBusConfigSchema,
  PING,
  PONG,
  R,
} from "@ob/shared";
import WebSocket, { type RawData, WebSocketServer } from "ws";
// Imported by path: the CLI package is named `open-bus`, like the workspace root.
import { login } from "../../packages/cli/src/commands/login.ts";

// ── small utilities ────────────────────────────────────────────────────────

/** A fresh private directory. Short, because a Unix socket path is capped near 104 bytes. */
export function tmpDir(prefix = "e2e"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `ob-${prefix}-`)));
}

/** A directory whose `.openbus.json` sets the namespace (and, if asked, global). */
export function workspace(
  namespace: string,
  o: { global?: boolean } = {},
): string {
  const dir = tmpDir("ws");
  // Validated, but written as given: the daemon normalizes it as it would a user's file.
  const raw = { namespace, ...(o.global ? { global: true } : {}) };
  OpenBusConfigSchema.parse(raw);
  const file = join(dir, CONFIG_FILE);
  writeFileSync(file, `${JSON.stringify(raw)}\n`);
  chmodSync(file, 0o644);
  return dir;
}

/** Git with no user or system config, so no `insteadOf` rewrite or template leaks in. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function git(dir: string, args: string[]): string | null {
  try {
    return (
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: GIT_ENV,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** A git work tree whose `origin` is `remote`, with no `.openbus.json`. */
export function gitRepo(remote: string, name = "repo"): string {
  const dir = join(tmpDir("git"), name);
  mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"], {
    stdio: "ignore",
    env: GIT_ENV,
  });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], {
    stdio: "ignore",
    env: GIT_ENV,
  });
  return dir;
}

/**
 * The daemon's own resolver, with hermetic git. Its `.openbus.json` lookup
 * walks to `/` and has no stop seam, so instead a config anywhere above the
 * temp dir is refused up front: it would silently set every namespace.
 */
export function assertNoOuterConfig(base = realpathSync(tmpdir())): void {
  for (let dir = base; ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file))
      throw new Error(
        `${file} would apply to every e2e namespace (the lookup walks up from the temp dir): remove it or set TMPDIR elsewhere`,
      );
    if (dirname(dir) === dir) return;
  }
}
const hermeticNamespace = (log: (m: string) => void) => (cwd: string) =>
  resolveNamespace(cwd, {
    log,
    gitRemote: (d) => git(d, ["remote", "get-url", "origin"]),
    gitRoot: (d) => git(d, ["rev-parse", "--show-toplevel"]),
  });

/** Retries `fn` until it stops throwing, then returns its value. */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  o: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(o.intervalMs ?? 100);
    }
  }
}

export const sleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));
const wsUrl = (hub: string) =>
  `${hub.replace(/^http/, "ws").replace(/\/+$/, "")}${R.hub}`;
const findLast = <T>(xs: T[], f: (x: T) => boolean): T | undefined => {
  for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i] as T)) return xs[i];
  return undefined;
};
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Json = Record<string, unknown>;
const parseLoose = (text: string): Json | undefined => {
  try {
    const o = JSON.parse(text);
    return typeof o === "object" && o !== null && !Array.isArray(o)
      ? (o as Json)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The daemon's exact log line when its machine is revoked (packages/daemon/src/index.ts). */
export const REVOKED_LINE = "this machine was revoked; run `open-bus login`";

// ── the gate ───────────────────────────────────────────────────────────────

export type Gate =
  | { state: "run"; hub: string }
  | { state: "skip"; reason: string }
  | { state: "fail"; reason: string };

/**
 * Skip while E2E_HUB is unset or its /hub route is 404 (not deployed yet).
 * Run only when an upgrade without a token is refused with 401 or 426.
 * Anything else with E2E_HUB set (unreachable, 5xx, an accepted upgrade) fails.
 */
export async function liveHub(
  env: Record<string, string | undefined> = process.env,
  probe: (hub: string) => Promise<number> = probeUpgrade,
): Promise<Gate> {
  const hub = env.E2E_HUB?.replace(/\/+$/, "");
  // Seed mode is validated before anything, the probe included: it throws.
  const seed = seedMode(env);
  if (!hub) return { state: "skip", reason: "E2E_HUB is not set" };
  if (seed) assertSeedHub(hub);
  let status: number;
  try {
    status = await probe(hub);
  } catch (e) {
    return { state: "fail", reason: `${hub} is unreachable: ${msg(e)}` };
  }
  if (status === 404)
    return {
      state: "skip",
      reason: `GET ${hub}${R.hub} is 404: the hub is not deployed yet`,
    };
  if (status === 401 || status === 426) return { state: "run", hub };
  return {
    state: "fail",
    reason:
      status === 101
        ? `${hub}${R.hub} accepted an upgrade with no token`
        : `${hub}${R.hub} answered an upgrade with no token with ${status}, not 401 or 426`,
  };
}

/** The status the hub answers a `/hub` upgrade with (no token if omitted): 101 if accepted. */
export function probeUpgrade(hub: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(hub), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 10_000,
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", (e) => reject(e));
  });
}

// ── the browser session (approve, revoke) ──────────────────────────────────

type StorageState = {
  cookies?: {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
  }[];
};

/** The Cookie header a browser would send to `url`, from a Playwright storage state file. */
export function cookieHeader(stateFile: string, url: string): string {
  const u = new URL(url);
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as StorageState;
  const now = Date.now() / 1000;
  return (state.cookies ?? [])
    .filter((c) => {
      const d = c.domain.replace(/^\./, "");
      const domainOk =
        u.hostname === d ||
        (c.domain.startsWith(".") && u.hostname.endsWith(`.${d}`));
      const pathOk = u.pathname.startsWith(c.path ?? "/");
      const fresh = c.expires === undefined || c.expires < 0 || c.expires > now;
      return domainOk && pathOk && fresh;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** A REST call the hub refused; `status` lets a caller tolerate, say, a 404. */
export class RestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** What the user does in a browser: approve a device code, revoke a machine. */
export type RestSession = {
  approve: (userCode: string) => Promise<void>;
  revoke: (machineId: string) => Promise<void>;
};

export function restSession(hub: string, cookie: string): RestSession {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${hub.replace(/\/+$/, "")}${path}`, {
      method,
      redirect: "manual",
      headers: {
        cookie,
        [CSRF_HEADER]: CSRF_VALUE,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // The body is the hub's error JSON; it never holds a token.
      throw new RestError(
        `${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    }
    await res.body?.cancel();
  };
  return {
    approve: (userCode) =>
      call(
        "POST",
        R.approve(userCode),
        ApprovalBodySchema.parse({ decision: "approve" }),
      ),
    revoke: (machineId) => call("DELETE", R.machine(machineId)),
  };
}

/** The staging browser session: one real Access login by the user, saved as a storage state. */
export function stagingRest(
  hub: string,
  env: Record<string, string | undefined> = process.env,
): RestSession {
  const file = env.E2E_STORAGE_STATE;
  if (!file)
    throw new Error(
      "E2E_STORAGE_STATE is not set: it needs one real Access login by the user (file a blocker with scripts/ob-blocker.sh)",
    );
  return restSession(hub, cookieHeader(file, hub));
}

// ── the tap between a daemon and the hub ───────────────────────────────────

/** A request the daemon (or the harness) sent the hub, and the hub's reply by frame id, read by string. */
/** `res` is every frame the hub sent back with the request's id, in order; `res[0]` is the reply. */
export type Exchange = { req: Json; res: Json[] };

type Tap = {
  url: string;
  exchanges: Exchange[];
  /** `msg_id` -> `state` or `state: reason`, from receipt_update, in order. */
  updates: Map<string, string[]>;
  closeCodes: number[];
  /** Drop the link on both sides with no close frame. */
  sever: () => void;
  /** While true, the daemon's `ack` frames are recorded but not forwarded. */
  holdAcks: (hold: boolean) => void;
  /** Send a frame on the live upstream link, as this machine. */
  inject: (frame: ClientFrame) => boolean;
  close: () => Promise<void>;
};

async function tap(upstream: string): Promise<Tap> {
  const exchanges: Exchange[] = [];
  const byId = new Map<string, Exchange>();
  const updates = new Map<string, string[]>();
  const closeCodes: number[] = [];
  const links = new Set<WebSocket>();
  let live: { up: WebSocket; client?: WebSocket } | undefined;
  let hold = false;

  const fromDaemon = (text: string) => {
    const o = text === PING ? undefined : parseLoose(text);
    if (o && typeof o.id === "string" && o.type !== "ack") {
      const ex: Exchange = { req: o, res: [] };
      exchanges.push(ex);
      byId.set(o.id, ex);
    }
    return o;
  };
  const fromHub = (text: string) => {
    if (text === PONG) return;
    const o = parseLoose(text);
    if (!o) return;
    if (o.type === "receipt_update" && typeof o.msg_id === "string") {
      const label =
        typeof o.reason === "string"
          ? `${o.state}: ${o.reason}`
          : String(o.state);
      updates.set(o.msg_id, [...(updates.get(o.msg_id) ?? []), label]);
    }
    const ex = typeof o.id === "string" ? byId.get(o.id) : undefined;
    ex?.res.push(o);
  };

  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_q, s) => s.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    // A peer resetting mid-handshake must not become an uncaught error.
    socket.on("error", () => {});
    const up = new WebSocket(wsUrl(upstream), {
      headers: { authorization: req.headers.authorization ?? "" },
    });
    links.add(up);
    const link: { up: WebSocket; client?: WebSocket } = { up };
    const early: RawData[] = [];
    up.on("unexpected-response", (_r, res) => {
      res.resume();
      // A refused upgrade (401/403 on a revoked token) reaches the daemon as is.
      socket.end(
        `HTTP/1.1 ${res.statusCode} Refused\r\nContent-Length: 0\r\n\r\n`,
      );
      up.terminate();
    });
    up.on("error", () => {
      if (!link.client) socket.destroy();
    });
    up.on("open", () => {
      live = link;
      wss.handleUpgrade(req, socket, head, (ws) => {
        link.client = ws;
        links.add(ws);
        ws.on("error", () => {
          /* close follows */
        });
        for (const d of early.splice(0)) ws.send(d, { binary: false });
        ws.on("message", (d) => {
          const o = fromDaemon(String(d));
          if (hold && o?.type === "ack") return;
          if (up.readyState === WebSocket.OPEN) up.send(d, { binary: false });
        });
        ws.on("close", () => up.close());
      });
    });
    up.on("message", (d) => {
      fromHub(String(d));
      if (link.client) link.client.send(d, { binary: false });
      else early.push(d);
    });
    up.on("close", (code, reason) => {
      closeCodes.push(code);
      if (live === link) live = undefined;
      // 1005/1006 cannot be sent: the daemon sees a dropped link, as it would.
      if (code === 1005 || code === 1006) link.client?.terminate();
      else link.client?.close(code, reason);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    exchanges,
    updates,
    closeCodes,
    sever: () => {
      live?.client?.terminate();
      live?.up.terminate();
    },
    holdAcks: (h) => {
      hold = h;
    },
    inject: (frame) => {
      const text = encodeFrame(ClientFrameSchema.parse(frame));
      if (live?.up.readyState !== WebSocket.OPEN) return false;
      fromDaemon(text);
      live.up.send(text);
      return true;
    },
    close: async () => {
      for (const l of links) l.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ── machines and sessions ──────────────────────────────────────────────────

export type MachineOptions = {
  /** The hub's https origin (or a loopback http one). */
  hub: string;
  rest: RestSession;
  /** Device-flow poll delay; defaults to the hub's own interval. */
  pollMs?: number;
  log?: (line: string) => void;
  /**
   * Seed mode (E2E_SEED=1): take the machine from a local `wrangler dev`
   * hub's `POST /__e2e/machine` instead of the device flow. Loopback hubs only.
   */
  seed?: boolean;
  /**
   * Seed mode: the probe found `DELETE /__e2e/machine/:id` (seedRevokeRoute).
   * Then dispose must get a 204 unless the machine is already revoked;
   * without it dispose makes no revoke call at all.
   */
  seedRevoke?: boolean;
};

/**
 * IP literals only, compared after WHATWG URL parsing, which normalises
 * `0x7f.0.0.1`, `2130706433` or `[0:0:0:0:0:0:0:1]` to these. No `localhost`:
 * a name can resolve anywhere.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const SEED_PATH = "/__e2e/machine";

/** Seed mode mints machines on a local hub; it must never aim at a real one. */
export function assertSeedHub(hub: string): void {
  let host: string;
  try {
    host = new URL(hub).hostname;
  } catch {
    throw new Error(`E2E_SEED needs a valid E2E_HUB, got ${hub}`);
  }
  if (!LOOPBACK_HOSTS.has(host))
    throw new Error(
      `E2E_SEED=1 runs only against a loopback IP hub (127.0.0.1 or [::1]); E2E_HUB is ${hub}`,
    );
}

/** E2E_SEED: unset or empty is off, "1" is on, anything else is a mistake. */
export function seedMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env.E2E_SEED;
  if (v === undefined || v === "") return false;
  if (v === "1") return true;
  throw new Error(
    `E2E_SEED accepts only "1" (or unset); got ${JSON.stringify(v)}`,
  );
}

/**
 * Seed mode has no owner session. Approve is not available; revoke goes to
 * the local e2e entry's `DELETE /__e2e/machine/:id`, which calls the same hub
 * revoke path as `DELETE /api/v1/machines/:id` (204, or 404 for an unknown id).
 */
export function seedRest(hub: string): RestSession {
  assertSeedHub(hub);
  return {
    approve: async () => {
      throw new Error("seed mode has no owner session to approve with");
    },
    revoke: async (machineId) => {
      assertSeedHub(hub);
      const path = `${SEED_PATH}/${encodeURIComponent(machineId)}`;
      const res = await fetch(`${hub}${path}`, {
        method: "DELETE",
        headers: { "X-OB-E2E": "1" },
        redirect: "error",
      });
      if (!res.ok)
        throw new RestError(
          `DELETE ${path} failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
          res.status,
        );
      await res.body?.cancel();
    },
  };
}

export type SeedRevokeProbe = { present: boolean; how: string };

/**
 * Whether the local hub has a working `DELETE /__e2e/machine/:id` (B9): seed a
 * throwaway machine, delete it (must be 204), delete it again (must be 404).
 * Anything else, a 405, the Worker's generic 404, a redirect or a network
 * error, means the route is not there yet. `how` says which way it went.
 */
export async function seedRevokeRoute(hub: string): Promise<SeedRevokeProbe> {
  assertSeedHub(hub);
  const absent = (how: string) => ({ present: false, how: `absent: ${how}` });
  try {
    const seeded = await fetch(`${hub}${SEED_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-OB-E2E": "1" },
      redirect: "error",
      body: JSON.stringify({ label: "e2e-probe" }),
    });
    const m = parseLoose(await seeded.text());
    if (!seeded.ok || typeof m?.machine_id !== "string")
      return absent(`POST ${SEED_PATH} answered ${seeded.status}`);
    const del = async () => {
      const res = await fetch(
        `${hub}${SEED_PATH}/${encodeURIComponent(String(m.machine_id))}`,
        { method: "DELETE", headers: { "X-OB-E2E": "1" }, redirect: "error" },
      );
      await res.body?.cancel();
      return res.status;
    };
    const first = await del();
    if (first !== 204) return absent(`first DELETE answered ${first}, not 204`);
    const second = await del();
    if (second !== 404)
      return absent(`second DELETE answered ${second}, not 404`);
    return { present: true, how: "present: DELETE answered 204, then 404" };
  } catch (e) {
    return absent(msg(e));
  }
}

/** The machine options for `pnpm e2e:staging`: seed mode under E2E_SEED=1, else the stored browser session. */
export function envMachineOptions(
  hub: string,
  env: Record<string, string | undefined> = process.env,
  o: { seedRevoke?: boolean } = {},
): MachineOptions {
  if (seedMode(env)) {
    assertSeedHub(hub);
    // Revoke goes to the local seed route, only once the probe found it.
    return {
      hub,
      rest: seedRest(hub),
      seed: true,
      seedRevoke: o.seedRevoke === true,
    };
  }
  return { hub, rest: stagingRest(hub, env) };
}

/** Writes machine.json as `open-bus login` does: the home 0700, the file 0600. */
function writeMachineJson(home: string, body: unknown): void {
  chmodSync(home, 0o700);
  const file = join(home, "machine.json");
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function seedMachine(
  hub: string,
  home: string,
  label: string,
): Promise<{ machineId: string }> {
  assertSeedHub(hub);
  const res = await fetch(`${hub}${SEED_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-OB-E2E": "1" },
    // A redirect could carry the request, and the minted token, off loopback.
    redirect: "error",
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    // Seeded machines outlive a run (and are never revoked without the
    // revoke route): after ~6 runs the hub's machine cap answers 409.
    const hint =
      res.status === 409 && body.includes("machine_limit")
        ? "; the local hub is full: run `pnpm --filter @ob/server dev:e2e:reset`"
        : "";
    throw new Error(`POST ${SEED_PATH} failed: ${res.status} ${body}${hint}`);
  }
  const m = (await res.json()) as Record<string, unknown>;
  if (typeof m.machine_id !== "string" || typeof m.machine_token !== "string")
    throw new Error(`POST ${SEED_PATH} returned no machine`);
  writeMachineJson(home, {
    hub,
    machine_id: m.machine_id,
    label: typeof m.label === "string" ? m.label : label,
    machine_token: m.machine_token,
  });
  return { machineId: m.machine_id };
}

export type Receipt = Extract<DaemonFrame, { type: "receipt" }>;
export type RosterEntry = Extract<
  DaemonFrame,
  { type: "roster" }
>["agents"][number];
export type AgentInfo = NonNullable<
  Extract<DaemonFrame, { type: "agent" }>["agent"]
>;

export type Session = {
  ref: string;
  kind: Kind;
  socketPath: string;
  /** The bus name the hub assigned, read with `self`. */
  name: () => Promise<string>;
  /** `self`: name, namespace, kind, global. */
  info: () => Promise<AgentInfo>;
  send: (to: string, body: string) => Promise<Receipt>;
  roster: () => Promise<RosterEntry[]>;
  /** The roster as the hub sent it (with `state`), from a fresh `list`. */
  hubRoster: () => Promise<Json[]>;
  /** `fetch` through the daemon; the local answer, or the error it raised. */
  fetch: (msgId: string) => Promise<DaemonFrame | Error>;
  /** The hub's raw reply to this session's latest request of `type` matching `where`. */
  hubReply: (type: string, where?: (req: Json) => boolean) => Json | undefined;
  /** Every mail the daemon handed the transport for this session, oldest first. */
  inbox: () => Mail[];
  /** The harness's TUI closes: presence evidence goes, the adapter stays connected. */
  closeTui: () => Promise<void>;
  /** The session's process dies; its session file stays (a Claude crash). */
  crash: () => Promise<void>;
  /**
   * The session's process exits and another takes its pid: same pid, new
   * start time, file unchanged. `deadMs` is how long the pid stays free in
   * between (0: the new process appears at once).
   */
  reusePid: (deadMs?: number) => Promise<void>;
  /**
   * The session ends: its liveness evidence goes and the adapter disconnects.
   * The daemon notices per kind: Claude by its session file (C5), Pi by the
   * connection, OpenCode by presence (C6).
   */
  close: () => Promise<void>;
  /** The same session (same agent_ref) opens again; a Claude one under a new pid. */
  reopen: () => Promise<void>;
};

export type Machine = {
  label: string;
  home: string;
  machineId: string;
  /** The hub this machine logged in to. */
  hub: string;
  token: () => string;
  session: (
    kind: Kind,
    agentRef: string,
    cwd: string,
    o?: { name?: string; attested?: boolean },
  ) => Promise<Session>;
  /** Drops (with a close frame) and restores the hub link; the daemon and its sessions stay up. */
  offline: () => Promise<void>;
  online: () => Promise<void>;
  /** Drops the hub link with no close frame; the daemon reconnects on its own. */
  sever: () => void;
  /** While held, this daemon's acks never reach the hub. */
  holdAcks: (hold: boolean) => void;
  /** Sends a raw frame on this machine's link and waits for the hub's reply by id. */
  raw: (frame: ClientFrame, timeoutMs?: number) => Promise<Json | undefined>;
  /** Stops the daemon; `start` runs a new one on the same OPENBUS_HOME and re-hellos open sessions. */
  stop: () => Promise<void>;
  start: () => Promise<void>;
  revoke: () => Promise<void>;
  /** Whether this daemon holds `ref` as a live session (undefined if unknown). */
  live: (ref: string) => boolean | undefined;
  /** The daemon logged that its machine was revoked. */
  revoked: () => boolean;
  /** Close codes the hub sent on this machine's links, in order. */
  closeCodes: () => number[];
  /** `state` or `state: reason` from the hub's receipt_update frames for msg_id, in order. */
  receipts: (msgId: string) => string[];
  exchanges: () => Exchange[];
  /** Stops everything and revokes the machine (a 404, already revoked, is fine). */
  dispose: () => Promise<void>;
  /** `opencode` commands the daemon asked to run. The recorder runs none; expect this empty. */
  spawned: () => string[][];
  /** OpenBus notices told to sending sessions (expired or refused mail), by ref. */
  notices: () => { ref: string; text: string }[];
};

const PROC_START = "Thu Oct 22 10:00:00 2026";
const OTHER_START = "Thu Oct 22 11:30:00 2026";
let nextPid = 4_000_000;

/** Logs a fresh OPENBUS_HOME in to `opts.hub`, approves it, and starts its daemon. */
export async function machine(
  label: string,
  opts: MachineOptions,
): Promise<Machine> {
  const hub = opts.hub.replace(/\/+$/, "");
  if (opts.seed) assertSeedHub(hub);
  assertNoOuterConfig();
  const home = tmpDir("m");
  const log = opts.log ?? (() => {});
  const cleanup: (() => Promise<void> | void)[] = [
    () => rmSync(home, { recursive: true, force: true }),
  ];
  /** The pending revoke in `cleanup`, if this machine needs one. */
  let revokeOnce: (() => Promise<void>) | undefined;
  const runCleanup = async () => {
    for (const f of cleanup.splice(0).reverse()) {
      try {
        await f();
      } catch {}
    }
  };

  try {
    return await build();
  } catch (e) {
    await runCleanup();
    throw e;
  }

  async function build(): Promise<Machine> {
    const machineId = opts.seed
      ? (await seedMachine(hub, home, label)).machineId
      : await deviceLogin();
    // From here on a failure leaves a machine behind: revoke it (in seed
    // mode through the seed route, see seedRest).
    if (!opts.seed || opts.seedRevoke) {
      revokeOnce = () => opts.rest.revoke(machineId);
      cleanup.push(revokeOnce);
    }
    return run(machineId);
  }

  async function deviceLogin(): Promise<string> {
    // 1. Device login, approved over REST the moment the code is minted. A
    // rejected approval ends the login at once instead of polling to expiry.
    let failed: unknown;
    let rejectApproval!: (e: unknown) => void;
    const approvalFailed = new Promise<never>((_r, reject) => {
      rejectApproval = reject;
    });
    approvalFailed.catch(() => {});
    const tapFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith(R.deviceCode) && res.ok) {
        const code = DeviceCodeResponseSchema.parse(await res.clone().json());
        opts.rest.approve(code.user_code).catch((e) => {
          failed = e;
          rejectApproval(new Error(`approval failed: ${msg(e)}`));
        });
      }
      return res;
    };
    const result = await Promise.race([
      login({
        hub,
        home,
        label,
        noOpen: true,
        fetch: tapFetch,
        openBrowser: async () => false,
        sleep: async (ms) => {
          if (failed) throw failed; // stops the abandoned poll loop
          await sleep(opts.pollMs ?? ms);
        },
        now: Date.now,
        print: log,
      }),
      approvalFailed,
    ]);
    return result.machineId;
  }

  async function run(machineId: string): Promise<Machine> {
    // 2. The daemon's own config reader, pointed at this home.
    const prev = {
      home: process.env.OPENBUS_HOME,
      hubEnv: process.env.OPENBUS_HUB,
    };
    process.env.OPENBUS_HOME = home;
    delete process.env.OPENBUS_HUB;
    let cfg: ReturnType<typeof readConfig>;
    try {
      cfg = readConfig();
    } finally {
      restoreEnv("OPENBUS_HOME", prev.home);
      restoreEnv("OPENBUS_HUB", prev.hubEnv);
    }

    // 3. Harness evidence the real attest() checks, and per-session inboxes.
    const claudeDir = join(home, "claude-sessions");
    mkdirSync(claudeDir, { mode: 0o700 });
    const tuiOpen = new Set<string>();
    /**
     * This machine's fake process table: pid -> start time. A session's
     * process is entered here; `crash()` takes it out (the pid is dead) and
     * `reusePid()` gives it another start time (a new process on the same
     * pid). The daemon's isRunning and procStart seams read only this table.
     */
    const procs = new Map<number, string>();
    const isRunning = (pid: number) => procs.has(pid);
    const procStart = (pid: number) => procs.get(pid) ?? null;
    const calls = new Map<string, Mail[]>();
    /** Every `opencode` command the daemon asked to run; none is ever run. */
    const spawned: string[][] = [];
    /**
     * OpenBus notices (expired or refused mail) the daemon told a sender:
     * recorded in place of Claude's and OpenCode's notifiers; a Pi session's
     * arrive on its own connection through the daemon's real Pi path.
     */
    const notices: { ref: string; text: string }[] = [];
    const sessions: SessionImpl[] = [];
    // Unconditional: the transport never second-guesses the daemon's gate.
    const inject: DeliverFn = async (agent, mail) => {
      calls.set(agent.ref, [...(calls.get(agent.ref) ?? []), mail]);
      return { ok: true };
    };

    const record = async (agent: { ref: string }, text: string) => {
      notices.push({ ref: agent.ref, text });
      return true;
    };

    // 4. The tap, then the daemon behind it.
    const link = await tap(hub);
    cleanup.push(() => link.close());
    const socketPath = join(home, "daemon.sock");
    let revoked = false;
    let daemon: Daemon | undefined;
    const start = async () => {
      daemon = await runDaemon({
        config: { ...cfg, hub: link.url },
        socketPath,
        transports: { "claude-code": inject, opencode: inject, pi: inject },
        notifiers: {
          "claude-code": record,
          opencode: record,
        },
        resolveNamespace: hermeticNamespace((line) => log(`${label}: ${line}`)),
        attest: (hello) =>
          attest(hello, {
            sessionsDir: claudeDir,
            ancestors: (pid) => [pid],
            procStart,
            openSessions: () => tuiOpen,
            // Every fake OpenCode adapter runs under the OpenCode service.
            comm: () => "opencode",
          }),
        hub: { backoffMs: () => 250 },
        // The daemon finds Claude sessions from their files on its own (C5):
        // point it at this machine's fake sessions dir, never the user's, and
        // keep its return sockets and held file under this OPENBUS_HOME.
        claude: {
          sessionsDir: claudeDir,
          socketsDir: join(home, "claude-return"),
          heldFile: join(home, "claude-held.json"),
          procStart,
          isRunning,
          syncMs: 200,
        },
        // OpenCode liveness is presence (C6): this machine's TUI set, never the user's files.
        // Never a real `opencode`: the recorder runs nothing.
        opencode: {
          openSessions: () => tuiOpen,
          isRunning,
          procStart,
          spawn: async (cmd, args) => {
            spawned.push([cmd, ...args]);
            return { code: 0, stdout: "{}", stderr: "" };
          },
        },
        log: (line) => {
          log(`${label}: ${line}`);
          if (line === REVOKED_LINE) {
            revoked = true;
            // runDaemon marks the process failed on revoke; this process is the test runner.
            const code = process.exitCode;
            queueMicrotask(() => {
              process.exitCode = code;
            });
          }
        },
      });
    };
    await start();
    cleanup.push(() => daemon?.stop());

    type SessionImpl = Session & {
      connected: boolean;
      reconnect: () => Promise<void>;
    };

    const session: Machine["session"] = async (kind, ref, cwd, o = {}) => {
      let pid = nextPid++;
      const evidence = (on: boolean) => {
        if (kind === "opencode") {
          if (on) tuiOpen.add(ref);
          else tuiOpen.delete(ref);
        } else if (kind === "pi") {
          if (on) procs.set(pid, PROC_START);
          else procs.delete(pid);
        } else {
          if (on) procs.set(pid, PROC_START);
          else procs.delete(pid);
          const file = join(claudeDir, `${pid}.json`);
          if (on)
            writeFileSync(
              file,
              JSON.stringify({
                pid,
                sessionId: ref,
                procStart: PROC_START,
                cwd,
                ...(o.name ? { name: o.name } : {}),
              }),
            );
          else rmSync(file, { force: true });
        }
      };
      if (o.attested !== false) evidence(true);
      const hello = (): Hello =>
        Hello.parse({
          v: 1,
          id: `h${nextPid++}`,
          type: "hello",
          kind,
          agent_ref: ref,
          pid,
          cwd,
          ...(o.name ? { proposed_name: o.name } : {}),
          attest:
            kind === "pi"
              ? { proc_start: PROC_START }
              : kind === "opencode"
                ? { session_id: ref }
                : {},
        });
      const connect = async () => {
        const c = await connectDaemon({ path: socketPath, hello: hello() });
        if (kind === "pi") c.onNotice((text) => notices.push({ ref, text }));
        return c;
      };
      let client: DaemonClient = await connect();
      const ask = async (frame: Parameters<DaemonClient["request"]>[0]) => {
        const r = await client.request(frame);
        if (r.type === "error")
          throw new Error(`${frame.type} failed: ${r.code}: ${r.message}`);
        return r;
      };
      const reply = (
        type: string,
        where: (req: Json) => boolean = () => true,
      ) =>
        findLast(
          link.exchanges,
          (x) => x.req.type === type && x.req.from_ref === ref && where(x.req),
        )?.res[0];
      const info = async () => {
        const r = await ask({ type: "self" });
        if (r.type !== "agent" || !r.agent)
          throw new Error(`self: unexpected ${r.type}`);
        return r.agent;
      };
      const roster = async () => {
        const r = await ask({ type: "list" });
        if (r.type !== "roster") throw new Error(`list: unexpected ${r.type}`);
        return r.agents;
      };
      const s: SessionImpl = {
        ref,
        kind,
        socketPath,
        connected: true,
        info,
        name: async () => (await info()).name,
        send: async (to, body) => {
          const r = await ask({ type: "send", to, body });
          if (r.type !== "receipt")
            throw new Error(`send: unexpected ${r.type}`);
          return r;
        },
        roster,
        hubRoster: async () => {
          await roster();
          const res = reply("list");
          return Array.isArray(res?.agents) ? (res.agents as Json[]) : [];
        },
        fetch: (msgId) =>
          client.request({ type: "fetch", msg_id: msgId }).catch((e) => e),
        hubReply: reply,
        inbox: () => [...(calls.get(ref) ?? [])],
        closeTui: async () => evidence(false),
        crash: async () => {
          procs.delete(pid);
        },
        reusePid: async (deadMs = 0) => {
          if (!procs.has(pid)) return;
          if (deadMs > 0) {
            procs.delete(pid);
            await sleep(deadMs);
          }
          procs.set(pid, OTHER_START);
        },
        close: async () => {
          evidence(false);
          s.connected = false;
          client.close();
        },
        reopen: async () => {
          // A reopened Claude session is a new process (`claude --resume`).
          if (kind === "claude-code") pid = nextPid++;
          evidence(true);
          await s.reconnect();
        },
        reconnect: async () => {
          client = await connect();
          s.connected = true;
        },
      };
      sessions.push(s);
      // Registered once the hub's name for it is in its own roster: `self`
      // reads the proposal until agent_ok lands, so poll self against the roster.
      await eventually(async () => {
        const me = await info();
        const listed = await roster();
        if (
          !listed.some(
            (a) => a.name === me.name && a.namespace === me.namespace,
          )
        )
          throw new Error(`${ref} is not in its own roster yet`);
      });
      return s;
    };

    return {
      label,
      home,
      hub,
      machineId,
      spawned: () => spawned.map((c) => [...c]),
      notices: () => [...notices],
      token: () => cfg.machine_token,
      session,
      offline: async () => daemon?.hub.stop(),
      online: async () => daemon?.hub.start(),
      sever: () => link.sever(),
      holdAcks: (h) => link.holdAcks(h),
      raw: async (frame, timeoutMs = 10_000) => {
        const closes = link.closeCodes.length;
        if (!link.inject(frame)) throw new Error("the hub link is down");
        const ex = findLast(link.exchanges, (x) => x.req.id === frame.id);
        // The hub's reply by id, or the close code if it dropped the link instead.
        return eventually(
          (): Json => {
            if (ex?.res[0]) return ex.res[0];
            if (link.closeCodes.length > closes)
              return { closed: link.closeCodes[closes] };
            throw new Error("no reply yet");
          },
          { timeoutMs },
        ).catch(() => undefined);
      },
      stop: async () => {
        await daemon?.stop();
        daemon = undefined;
      },
      start: async () => {
        if (daemon) return;
        await start();
        for (const s of sessions) if (s.connected) await s.reconnect();
      },
      revoke: () => opts.rest.revoke(machineId),
      live: (ref) => daemon?.agents.byRef(ref)?.live,
      revoked: () => revoked,
      closeCodes: () => [...link.closeCodes],
      receipts: (id) => [...(link.updates.get(id) ?? [])],
      exchanges: () => [...link.exchanges],
      dispose: async () => {
        for (const s of sessions) if (s.connected) await s.close();
        const i = revokeOnce ? cleanup.indexOf(revokeOnce) : -1;
        if (i >= 0)
          cleanup.splice(
            i,
            1,
            opts.seed
              ? // The probed seed route: a 204 is required, unless the daemon
                // already saw this machine revoked (scenario 5).
                async () => {
                  if (!revoked) await opts.rest.revoke(machineId);
                }
              : // The owner-session route tolerates a 404: revoked already.
                async () => {
                  try {
                    await opts.rest.revoke(machineId);
                  } catch (e) {
                    if (!(e instanceof RestError && e.status === 404)) throw e;
                  }
                },
          );
        const errors: unknown[] = [];
        for (const f of cleanup.splice(0).reverse()) {
          try {
            await f();
          } catch (e) {
            errors.push(e);
          }
        }
        if (errors.length) throw errors[0];
      },
    };
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
