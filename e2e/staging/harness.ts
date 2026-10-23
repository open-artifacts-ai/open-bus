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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attest,
  type Daemon,
  type DeliverFn,
  type Mail,
  readConfig,
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

/** A git work tree whose `origin` is `remote`, with no `.openbus.json`. */
export function gitRepo(remote: string, name = "repo"): string {
  const dir = join(tmpDir("git"), name);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", remote);
  return dir;
}

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
): Promise<Gate> {
  const hub = env.E2E_HUB?.replace(/\/+$/, "");
  if (!hub) return { state: "skip", reason: "E2E_HUB is not set" };
  let status: number;
  try {
    status = await probeUpgrade(hub);
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
export type Exchange = { req: Json; res?: Json };

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
      const ex: Exchange = { req: o };
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
    if (ex && !ex.res) ex.res = o;
  };

  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer((_q, s) => s.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
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
};

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
  /** The session ends: evidence goes and the adapter disconnects. */
  close: () => Promise<void>;
  /** The same session (same agent_ref) opens again. */
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
  /** The daemon logged that its machine was revoked. */
  revoked: () => boolean;
  /** Close codes the hub sent on this machine's links, in order. */
  closeCodes: () => number[];
  /** `state` or `state: reason` from the hub's receipt_update frames for msg_id, in order. */
  receipts: (msgId: string) => string[];
  exchanges: () => Exchange[];
  /** Stops everything and revokes the machine (a 404, already revoked, is fine). */
  dispose: () => Promise<void>;
};

const PROC_START = "Thu Oct 22 10:00:00 2026";
let nextPid = 4_000_000;

/** Logs a fresh OPENBUS_HOME in to `opts.hub`, approves it, and starts its daemon. */
export async function machine(
  label: string,
  opts: MachineOptions,
): Promise<Machine> {
  const hub = opts.hub.replace(/\/+$/, "");
  const home = tmpDir("m");
  const log = opts.log ?? (() => {});
  const cleanup: (() => Promise<void> | void)[] = [
    () => rmSync(home, { recursive: true, force: true }),
  ];
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
    const machineId = result.machineId;
    // From here on a failure leaves an approved machine behind: revoke it.
    cleanup.push(() => opts.rest.revoke(machineId));

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
    const piStarts = new Map<number, string>();
    const calls = new Map<string, Mail[]>();
    const sessions: SessionImpl[] = [];
    const claudeFile = (pid: number) => {
      try {
        return readFileSync(join(claudeDir, `${pid}.json`), "utf8");
      } catch {
        return undefined;
      }
    };
    // Unconditional: the transport never second-guesses the daemon's gate.
    const inject: DeliverFn = async (agent, mail) => {
      calls.set(agent.ref, [...(calls.get(agent.ref) ?? []), mail]);
      return { ok: true };
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
        attest: (hello) =>
          attest(hello, {
            sessionsDir: claudeDir,
            ancestors: (pid) => [pid],
            procStart: (pid) =>
              piStarts.get(pid) ?? (claudeFile(pid) ? PROC_START : null),
            openSessions: () => tuiOpen,
          }),
        hub: { backoffMs: () => 250 },
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

    type SessionImpl = Session & { connected: boolean };

    const session: Machine["session"] = async (kind, ref, cwd, o = {}) => {
      const pid = nextPid++;
      const evidence = (on: boolean) => {
        if (kind === "opencode") {
          if (on) tuiOpen.add(ref);
          else tuiOpen.delete(ref);
        } else if (kind === "pi") {
          if (on) piStarts.set(pid, PROC_START);
          else piStarts.delete(pid);
        } else {
          const file = join(claudeDir, `${pid}.json`);
          if (on)
            writeFileSync(
              file,
              JSON.stringify({
                pid,
                sessionId: ref,
                procStart: PROC_START,
                cwd,
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
          attest: kind === "pi" ? { proc_start: PROC_START } : {},
        });
      let client: DaemonClient = await connectDaemon({
        path: socketPath,
        hello: hello(),
      });
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
        )?.res;
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
        close: async () => {
          evidence(false);
          s.connected = false;
          client.close();
        },
        reopen: async () => {
          evidence(true);
          client = await connectDaemon({ path: socketPath, hello: hello() });
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
            if (ex?.res) return ex.res;
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
        for (const s of sessions) if (s.connected) await s.reopen();
      },
      revoke: () => opts.rest.revoke(machineId),
      revoked: () => revoked,
      closeCodes: () => [...link.closeCodes],
      receipts: (id) => [...(link.updates.get(id) ?? [])],
      exchanges: () => [...link.exchanges],
      dispose: async () => {
        for (const s of sessions) if (s.connected) await s.close();
        // The revoke cleanup tolerates a 404: the machine may be revoked already.
        cleanup.splice(1, 1, async () => {
          try {
            await opts.rest.revoke(machineId);
          } catch (e) {
            if (!(e instanceof RestError && e.status === 404)) throw e;
          }
        });
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
