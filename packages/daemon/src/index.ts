import { lstatSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { claudeSessionsDir } from "@ob/adapter-claude-code";
import {
  MIN_PROMPT_ID_VERSION,
  opencodeVersion,
  supportsPromptId,
} from "@ob/adapter-opencode/version";
import {
  type DaemonFrame,
  fitName,
  type Hello,
  isWellFormed,
  receiptText,
  serveDaemon,
  stripTerminalControls,
} from "@ob/ipc";
import {
  type ClientFrame,
  ClientFrameSchema,
  frameId,
  WireNamespaceSchema,
} from "@ob/shared";
import { type AgentRecord, AgentTable } from "./agents.ts";
import { type Attest, attest, commOf, procStartOf } from "./attest.ts";
import {
  type Config,
  claudeReturnDir,
  home,
  prepareReturnDir,
  prepareSocketDir,
  readConfig,
  StartError,
  socketPath,
} from "./config.ts";
import { createDeliver, type DeliverFn, type NotifyFn } from "./deliver.ts";
import { HubConnection, type HubOptions } from "./hub.ts";
import {
  cachedProcStart,
  claudeTarget,
  isRunning,
  liveClaudeSessions,
} from "./liveness/claude.ts";
import { type Namespace, resolveNamespace } from "./namespace.ts";
import { Outbox } from "./outbox.ts";
import {
  lstartEpoch,
  opencodePresenceDir,
  openSessions,
} from "./presence/opencode.ts";
import { type AgentCap, capOf, Pending, routeLocal } from "./routes.ts";
import { type Notice, Receipts, SentStore } from "./sent.ts";
import { ClaudeTransport } from "./transports/claude.ts";
import { HeldStore } from "./transports/held.ts";
import {
  execSpawn,
  OpenCodeTransport,
  type Spawn,
  spawnExec,
} from "./transports/opencode.ts";
import { PiTransport } from "./transports/pi.ts";

export * from "./agents.ts";
export * from "./attest.ts";
export * from "./config.ts";
export * from "./dedupe.ts";
export * from "./deliver.ts";
export * from "./hub.ts";
export * from "./liveness/claude.ts";
export * from "./namespace.ts";
export * from "./outbox.ts";
export * from "./presence/opencode.ts";
export * from "./routes.ts";
export * from "./sent.ts";
export * from "./transports/claude.ts";
export * from "./transports/opencode.ts";
export * from "./transports/pi.ts";

const NOTICE_RETRY_MS = 30_000;
/** A registration the hub rate-limited is retried this late, or on the next reconnect. */
const LIMITED_RETRY_MS = 5 * 60_000;

export type DaemonDeps = {
  transports?: Partial<Record<AgentRecord["kind"], DeliverFn>>;
  /** Per-harness notices to a sending session; OpenCode and Pi add theirs here. */
  notifiers?: Partial<Record<AgentRecord["kind"], NotifyFn>>;
  /** Outgoing msg_ids awaiting a final receipt (0600); default ~/.openbus/sent.json. */
  sentFile?: string;
  version?: string;
  log?: (msg: string) => void;
  /** The hub refused this machine's token; `open-bus daemon` exits on it. */
  onRevoked?: () => void;
  /** The bound socket was removed or replaced; `open-bus daemon` exits 1 so the service rebinds. */
  onSocketLost?: () => void;
  /** How often the bound socket is checked; default 60 s. */
  socketCheckMs?: number;
  /** Written on revoke for `open-bus status` and doctor; default ~/.openbus/revoked. */
  revokedFile?: string;
  /** How long status waits for each namespace's roster from the hub. */
  statusRosterMs?: number;
  /** Retry delay for a rate-limited agent_up; default 5 min. */
  limitedRetryMs?: number;
  /** Test seams. */
  config?: Config;
  socketPath?: string;
  attest?: (hello: Parameters<typeof attest>[0]) => Attest;
  resolveNamespace?: (cwd: string) => Namespace;
  pendingTimeoutMs?: number;
  hub?: Partial<Pick<HubOptions, "backoffMs" | "pingMs" | "stableMs" | "pace">>;
  claude?: {
    sessionsDir?: string;
    socketsDir?: string;
    statusWindowMs?: number;
    injectTimeoutMs?: number;
    heldFile?: string;
    syncMs?: number;
    procStart?: (pid: number) => string | null;
    isRunning?: (pid: number) => boolean;
  };
  opencode?: {
    /** TUI presence files; default ~/.openbus/opencode-tui. */
    presenceDir?: string;
    /** Replaces reading presence files: the open root session ids. */
    openSessions?: () => Set<string>;
    /** Runs `opencode api`; default execFile with a 20 s kill timeout. */
    spawn?: Spawn;
    procStart?: (pid: number) => string | null;
    isRunning?: (pid: number) => boolean;
    ancestors?: (pid: number) => number[];
    comm?: (pid: number) => string | null;
    /** Read once at start; default `opencode --version`. */
    version?: () => Promise<string | undefined>;
    /** Prompts that timed out below the prompt-id floor; default ~/.openbus/opencode-uncertain.json. */
    uncertainFile?: string;
  };
  pi?: {
    /** How long the extension has to hand a message to Pi and ack it. */
    ackTimeoutMs?: number;
  };
};

export type Daemon = {
  stop: () => Promise<void>;
  hub: HubConnection;
  agents: AgentTable;
};

export async function runDaemon(deps: DaemonDeps = {}): Promise<Daemon> {
  const cfg = deps.config ?? readConfig();
  const log = deps.log ?? ((msg: string) => console.error(`openbus: ${msg}`));
  const agents = new AgentTable();
  // A timed-out request still queued is dropped: an adapter's retry must not send twice.
  const pending = new Pending(deps.pendingTimeoutMs, (id) => {
    if (hub.cancel(id)) receipts.forget(id);
  });
  /** Open local connections per agent_ref; the agent is closed when the last one goes. */
  const conns = new Map<string, number>();
  /** Each Pi session's open extension connections, newest last: Pi receives on them. */
  const piLinks = new Map<string, Map<Hello, (f: DaemonFrame) => void>>();

  const sessions = () => ({
    open: agents.openRefs(),
    closed: agents.closedRefs(),
  });
  const announceSessions = () => {
    // Every close goes through here: a closed agent's rate limit mark goes with it.
    for (const ref of limited.keys())
      if (!agents.byRef(ref)?.live) clearLimited(ref);
    return hub.send({ v: 1, id: frameId(), type: "sessions", ...sessions() });
  };
  /** agent_up ids awaiting the hub's answer, to their agent_ref; cleared with the link. */
  const upIds = new Map<string, string>();
  /** Agents the hub refused to register (rate_limited), each with its retry timer. */
  const limited = new Map<string, NodeJS.Timeout>();
  /** The cap each refused agent hit. */
  const caps = new Map<string, AgentCap>();
  const announceUp = (rec: AgentRecord) => {
    const id = frameId();
    upIds.set(id, rec.ref);
    return hub.send({
      v: 1,
      id,
      type: "agent_up",
      agent_ref: rec.ref,
      kind: rec.kind,
      proposed_name: fitName(rec.proposedName, 64),
      namespace: rec.namespace,
      global: rec.global,
    });
  };
  /** Never a loop: one retry after a long wait; a reconnect replays it sooner. */
  const markLimited = (ref: string, message: string) => {
    if (!limited.has(ref))
      log(`the hub refused to register ${ref}: too many agents (rate limited)`);
    caps.set(ref, capOf(message));
    clearTimeout(limited.get(ref));
    const timer = setTimeout(() => {
      const rec = agents.byRef(ref);
      if (rec?.live && hub.open) announceUp(rec);
    }, deps.limitedRetryMs ?? LIMITED_RETRY_MS);
    timer.unref();
    limited.set(ref, timer);
  };
  const clearLimited = (ref: string) => {
    clearTimeout(limited.get(ref));
    limited.delete(ref);
    caps.delete(ref);
  };

  const resolveNs = (cwd: string, allowMissing: boolean) =>
    (
      deps.resolveNamespace ??
      ((dir) => resolveNamespace(dir, { log, allowMissing }))
    )(cwd);

  const cl = deps.claude ?? {};
  const listenPath = deps.socketPath ?? socketPath();
  const returnDir = cl.socketsDir ?? claudeReturnDir();
  // Before anything listens: a socket path that cannot work is a lasting failure.
  prepareSocketDir(listenPath, returnDir);
  const running = cl.isRunning ?? isRunning;
  const claudeSessions = {
    dir: cl.sessionsDir ?? claudeSessionsDir(),
    procStart: cachedProcStart(cl.procStart ?? procStartOf, running, {
      ttlMs: cl.syncMs ?? 2000,
    }),
    isRunning: running,
  };
  const oc = deps.opencode ?? {};
  const ocRunning = oc.isRunning ?? isRunning;
  const ocStart = cachedProcStart(oc.procStart ?? procStartOf, ocRunning, {
    ttlMs: cl.syncMs ?? 2000,
  });
  const ocComm = oc.comm ?? commOf;
  /** Each OpenCode record's service start time, taken at hello: a reused pid is not that service. */
  const ocServiceStart = new Map<string, string | null>();
  const ocServiceGone = (ref: string, pid: number) => {
    if (!ocRunning(pid)) return true;
    const comm = ocComm(pid);
    if (comm !== null && basename(comm) !== "opencode") return true;
    const start = ocServiceStart.get(ref);
    return start != null && ocStart(pid) !== start;
  };
  const presenceDir = oc.presenceDir ?? opencodePresenceDir();
  /** Read on every delivery, hello and tick: the TUI decides, not the adapter's connection. */
  const openCodeSessions =
    oc.openSessions ??
    (() =>
      openSessions(presenceDir, {
        isRunning: ocRunning,
        procStartEpoch: (pid, stamp) => lstartEpoch(ocStart(pid, stamp)),
      }));
  const ocSpawn = oc.spawn ?? execSpawn(20_000);
  /** Unknown until read, just before the hub link starts: no delivery comes sooner. */
  let promptIdSupported = false;
  const opencode = new OpenCodeTransport({
    openSessions: openCodeSessions,
    spawn: ocSpawn,
    log,
    promptIdSupported: () => promptIdSupported,
    uncertain: new HeldStore(
      oc.uncertainFile ?? join(home(), "opencode-uncertain.json"),
    ),
  });
  const pi = new PiTransport({
    push: (ref, frame) => {
      const push = [...(piLinks.get(ref)?.values() ?? [])].at(-1);
      if (!push) return false;
      push(frame);
      return true;
    },
    ackTimeoutMs: deps.pi?.ackTimeoutMs,
  });
  const sent = new SentStore(deps.sentFile ?? join(home(), "sent.json"), {
    log,
  });
  const receipts = new Receipts(sent);
  /** Every send is remembered, so its sender hears if it later expires or is refused. */
  const sendToHub = (
    f: ClientFrame,
    native = false,
    onUnsent?: () => void,
  ): boolean => {
    if (f.type === "send")
      receipts.sending(
        f,
        f.to_namespace ?? agents.byRef(f.from_ref)?.namespace,
        native,
      );
    return hub.send(f, onUnsent);
  };
  const notifiers: Partial<Record<AgentRecord["kind"], NotifyFn>> = {
    "claude-code": (agent, text) => claude.notify(agent, text),
    opencode: (agent, text, msgId) => opencode.notify(agent, text, msgId),
    pi: (agent, text, msgId) => pi.notify(agent, text, msgId),
    ...deps.notifiers,
  };
  /** msg_ids whose notice is being injected right now: never told twice at once. */
  const telling = new Set<string>();
  /** A notice for a sender that is not live stays stored until it is (or the TTL ends). */
  const tell = (n: Notice | undefined) => {
    if (!n || telling.has(n.msgId)) return;
    const agent = agents.byRef(n.meta.from_ref);
    const fn = agent?.live ? notifiers[agent.kind] : undefined;
    if (!agent || !fn) return;
    telling.add(n.msgId);
    void fn(
      agent,
      stripTerminalControls(
        receiptText(n, n.meta.to_name, undefined, n.meta.excerpt),
      ),
      n.msgId,
    )
      .then(
        (ok) => {
          if (ok) receipts.told(n.msgId);
          else log(`could not tell ${agent.busName} about ${n.meta.to_name}`);
        },
        (e: unknown) =>
          log(`notice failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => telling.delete(n.msgId));
  };
  const tellOwed = (ref: string) => {
    for (const n of receipts.owed(ref)) tell(n);
  };

  // A Claude reply must not be lost to a hub reconnect.
  const outbox = new Outbox<ClientFrame>({
    send: (f, unsent) => sendToHub(f, true, unsent),
    stale: (f) => f.type === "send" && !agents.byRef(f.from_ref)?.live,
    log,
  });
  const claude = new ClaudeTransport({
    socketsDir: returnDir,
    // A deps.socketsDir is the caller's (tests); ours is re-checked before each bind.
    prepareDir: cl.socketsDir ? undefined : (d) => prepareReturnDir(d),
    heldFile: cl.heldFile ?? join(home(), "claude-held.json"),
    statusWindowMs: cl.statusWindowMs,
    injectTimeoutMs: cl.injectTimeoutMs,
    log,
    target: (ref) => claudeTarget(ref, claudeSessions),
    // A native reply is a message from the session: the sink names the sender, never the frame.
    // Every reply names the peer's namespace (the deliver's), so a same-named local peer cannot get it.
    onReply: (agentRef, peerName, text, namespace) => {
      // A lone surrogate costs one character, not the reply.
      if (!isWellFormed(text))
        log(
          `a Claude reply to ${peerName} was not well-formed unicode; sent with U+FFFD`,
        );
      const body = (text as string & { toWellFormed(): string }).toWellFormed();
      const f: ClientFrame = {
        v: 1,
        id: frameId(),
        type: "send",
        from_ref: agentRef,
        to_name: peerName,
        to_namespace: namespace,
        body,
      };
      if (!ClientFrameSchema.safeParse(f).success) {
        log(`dropped a Claude reply to ${peerName}: not valid on the hub wire`);
        return;
      }
      outbox.push(f);
    },
  });

  /** Claude sessions exist before they call a tool: the daemon announces them from their session files. */
  const syncClaude = () => {
    const live = liveClaudeSessions(claudeSessions);
    const liveRefs = new Set(live.map((s) => s.ref));
    const livePid = (ref: string, pid: number) =>
      live.some((s) => s.ref === ref && s.pid === pid);
    for (const s of live) {
      const prev = agents.byRef(s.ref);
      if (prev && prev.kind !== "claude-code") continue;
      if (prev?.live) {
        // `claude --resume` brings the same session back under a new pid; while
        // the current one still runs it stays, so two files never flap.
        if (!livePid(s.ref, prev.pid)) prev.pid = s.pid;
        continue;
      }
      // Closed by a failed delivery and still the same process.
      if (prev && prev.pid === s.pid) continue;
      if (!isAbsolute(s.cwd)) continue;
      let ns: Namespace;
      try {
        ns = resolveNs(s.cwd, true);
      } catch {
        continue;
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success) continue;
      announceUp(
        agents.up({
          ref: s.ref,
          kind: "claude-code",
          proposedName: s.name,
          busName: prev?.busName ?? s.name,
          namespace: ns.namespace,
          global: ns.global,
          pid: s.pid,
          cwd: s.cwd,
          live: true,
        }),
      );
      tellOwed(s.ref);
    }
    let closed = false;
    for (const a of agents.all()) {
      if (a.kind !== "claude-code" || !a.live || liveRefs.has(a.ref)) continue;
      a.live = false;
      closed = true;
      void claude.drop(a.ref);
    }
    if (closed) announceSessions();
  };

  /** Open at the last tick: a session reopens only when a TUI newly lists it. */
  let openBefore = new Set<string>();
  /**
   * An OpenCode session becomes an agent at its first tool call, which names
   * its directory; presence then decides whether it is live.
   */
  const syncOpenCode = () => {
    const open = openCodeSessions();
    let closed = false;
    for (const a of agents.all()) {
      if (a.kind !== "opencode") continue;
      if (a.live && !open.has(a.ref)) {
        a.live = false;
        closed = true;
      } else if (!a.live && open.has(a.ref) && !openBefore.has(a.ref)) {
        // Closed by a failed delivery while still listed stays closed until relisted.
        a.live = true;
        announceUp(a);
        tellOwed(a.ref);
      }
    }
    openBefore = open;
    if (closed) announceSessions();
  };

  const delivery = createDeliver({
    agents,
    hub: { send: (f) => hub.send(f) },
    transports: {
      "claude-code": (agent, mail) => claude.deliver(agent, mail),
      opencode: (agent, mail) => opencode.deliver(agent, mail),
      pi: (agent, mail) => pi.deliver(agent, mail),
      ...deps.transports,
    },
    onClosed: announceSessions,
    log,
  });

  const hub = new HubConnection({
    url: `${cfg.hub.replace(/^http/, "ws").replace(/\/$/, "")}/hub`,
    token: cfg.machine_token,
    label: cfg.label,
    version: deps.version ?? process.env.OPENBUS_VERSION ?? "0.0.0",
    sessions,
    log,
    ...deps.hub,
    onFrame: (frame) => {
      switch (frame.type) {
        case "deliver":
          void delivery.deliver(frame);
          return;
        case "agent_ok": {
          upIds.delete(frame.id);
          clearLimited(frame.agent_ref);
          const agent = agents.byRef(frame.agent_ref);
          if (agent) agent.busName = frame.bus_name;
          return;
        }
        case "receipt":
          tell(receipts.receipt(frame));
          pending.settle(frame);
          return;
        case "receipt_update":
          tell(receipts.update(frame));
          return;
        case "error": {
          const upRef = upIds.get(frame.id);
          upIds.delete(frame.id);
          if (upRef !== undefined) {
            if (frame.code === "rate_limited")
              markLimited(upRef, frame.message);
            else log(`the hub refused to register ${upRef}: ${frame.code}`);
            return;
          }
          // An error answers one request by id; an unmatched one is dropped.
          receipts.forget(frame.id);
          pending.settle(frame);
          return;
        }
        case "roster":
          pending.settle(frame);
          return;
        case "body":
          // A fetched body is a peer's text, like a delivered one.
          pending.settle({ ...frame, body: stripTerminalControls(frame.body) });
          return;
        case "hello_ok":
          // Nothing to do: the machine id and label are already in machine.json.
          return;
        // roster_changed has no local consumer yet (C6).
      }
    },
    onBadFrame: (id, error) => {
      receipts.forget(id);
      pending.fail(id, error, "the hub sent a frame this daemon cannot read");
    },
    onRevoked: () => {
      log("this machine was revoked; run `open-bus login`");
      process.exitCode = 1;
      try {
        writeFileSync(
          deps.revokedFile ?? join(home(), "revoked"),
          `${JSON.stringify({ at: new Date().toISOString() })}\n`,
          { mode: 0o600 },
        );
      } catch (e) {
        log(
          `could not write the revoked marker: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      deps.onRevoked?.();
    },
    // The hub forgets agents with the link; sessions went out with hello.
    onOpen: () => {
      for (const rec of agents.all()) if (rec.live) announceUp(rec);
      outbox.flush();
    },
    onClose: () => {
      upIds.clear();
      pending.failAll("hub_unavailable", "the hub connection dropped");
    },
    onDropped: (f) => {
      upIds.delete(f.id);
      receipts.forget(f.id);
      pending.fail(f.id, "hub_unavailable", "the hub link is backed up");
    },
  });

  const version = deps.version ?? process.env.OPENBUS_VERSION ?? "0.0.0";
  /** The namespace roster as `ref` sees it, or undefined if the hub does not answer in time. */
  const hubRoster = (ref: string) =>
    new Promise<Extract<DaemonFrame, { type: "roster" }>["agents"] | undefined>(
      (resolve) => {
        const id = pending.open("status", (f) =>
          resolve(f.type === "roster" ? f.agents : undefined),
        );
        const timer = setTimeout(() => {
          pending.cancel(id);
          hub.cancel(id);
          resolve(undefined);
        }, deps.statusRosterMs ?? 1500);
        timer.unref();
        if (!hub.send({ v: 1, id, type: "list", from_ref: ref })) {
          clearTimeout(timer);
          pending.cancel(id);
          resolve(undefined);
        }
      },
    );
  // Another live daemon holds the socket, or the path cannot be bound: a restart cannot fix either.
  const socketInUse = (e: unknown): never => {
    const code = (e as { code?: unknown })?.code;
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "EADDRINUSE") throw new StartError("SOCKET_IN_USE", msg);
    if (
      code === "EINVAL" ||
      code === "ENAMETOOLONG" ||
      code === "EACCES" ||
      code === "ENOTSOCK"
    )
      throw new StartError(
        "SOCKET_PATH",
        `cannot listen on ${listenPath}: ${msg}`,
      );
    throw e;
  };
  const server = await serveDaemon({
    path: listenPath,
    // `open-bus status` and install's "Daemon running": one roster per namespace
    // this machine's open sessions are in (or only the cwd's).
    onStatus: async (req) => {
      let only: string | undefined;
      if (req.cwd && isAbsolute(req.cwd)) {
        try {
          only = resolveNs(req.cwd, true).namespace;
        } catch {}
      }
      const live = agents.all().filter((a) => a.live);
      const names = [
        ...new Set(
          req.cwd
            ? only === undefined
              ? []
              : [only]
            : live.map((a) => a.namespace),
        ),
      ];
      const namespaces = await Promise.all(
        names.map(async (namespace) => {
          const local = live.filter((a) => a.namespace === namespace);
          const mine = new Map(local.map((a) => [a.busName, a.kind]));
          const roster =
            local[0] && hub.open ? await hubRoster(local[0].ref) : undefined;
          const rows = roster
            ? roster.map((a) => ({
                name: a.name,
                kind: a.kind,
                machine:
                  a.machine_label ??
                  (mine.get(a.name) === a.kind ? cfg.label : ""),
                state: a.state ?? ("live" as const),
              }))
            : local.map((a) => ({
                name: a.busName,
                kind: a.kind,
                machine: cfg.label,
                state: "live" as const,
              }));
          return { namespace, agents: rows };
        }),
      );
      return {
        pid: process.pid,
        version,
        label: cfg.label,
        hub: hub.open ? "connected" : "connecting",
        ...(hub.open || !hub.lastError ? {} : { hub_error: hub.lastError }),
        ...(only === undefined ? {} : { namespace: only }),
        namespaces,
      };
    },
    onHello: (hello) => {
      const check = (
        deps.attest ??
        ((h) =>
          attest(h, {
            // The dir liveness reads: a session is attested where it is seen.
            sessionsDir: claudeSessions.dir,
            openSessions: openCodeSessions,
            ancestors: oc.ancestors,
            comm: oc.comm,
          }))
      )(hello);
      if (!check.ok) return { error: check.reason };
      // Claude's MCP server is a new process per tool call; the session is the identity.
      const pid = check.pid ?? hello.pid;
      const prev = agents.byRef(hello.agent_ref);
      // A resumed session may beat the next sync tick: the files decide whose it is.
      if (prev?.live && prev.kind === "claude-code" && prev.pid !== pid) {
        const live = liveClaudeSessions(claudeSessions).filter(
          (s) => s.ref === prev.ref,
        );
        if (
          live.some((s) => s.pid === pid) &&
          !live.some((s) => s.pid === prev.pid)
        )
          prev.pid = pid;
      }
      // `opencode service restart`: the session moves only once its old service is gone.
      if (
        prev?.live &&
        prev.kind === "opencode" &&
        hello.kind === "opencode" &&
        prev.pid !== pid &&
        ocServiceGone(prev.ref, prev.pid)
      ) {
        prev.pid = pid;
        ocServiceStart.set(prev.ref, ocStart(pid));
      }
      if (prev?.live) {
        if (prev.kind !== hello.kind || prev.pid !== pid) {
          return { error: "agent_ref is in use by another session" };
        }
        // The same session reconnecting keeps its record: never re-homed.
        conns.set(prev.ref, (conns.get(prev.ref) ?? 0) + 1);
        // Pi is told on its connection, which exists only once welcomed (onOpen).
        if (hello.kind !== "pi") tellOwed(prev.ref);
        return {
          bus_name: prev.busName,
          namespace: prev.namespace,
          global: prev.global,
        };
      }
      // Claude's session file names its cwd; other kinds state one.
      const cwd = check.cwd ?? hello.cwd;
      if (!isAbsolute(cwd)) return { error: "cwd must be absolute" };
      let ns: Namespace;
      try {
        // A live Claude session may have outlived its start directory.
        ns = resolveNs(cwd, check.cwd !== undefined);
      } catch {
        return { error: `cwd does not resolve: ${cwd}` };
      }
      if (!WireNamespaceSchema.safeParse(ns.namespace).success)
        return { error: `namespace is not valid on the wire: ${ns.namespace}` };
      const proposedName = hello.proposed_name ?? hello.agent_ref;
      const rec = agents.up({
        ref: hello.agent_ref,
        kind: hello.kind,
        proposedName,
        busName: prev?.busName ?? proposedName,
        namespace: ns.namespace,
        global: ns.global,
        pid,
        cwd,
        live: true,
      });
      if (rec.kind === "opencode") ocServiceStart.set(rec.ref, ocStart(pid));
      conns.set(rec.ref, (conns.get(rec.ref) ?? 0) + 1);
      announceUp(rec);
      if (hello.kind !== "pi") tellOwed(rec.ref);
      return {
        bus_name: rec.busName,
        namespace: rec.namespace,
        global: rec.global,
      };
    },
    onFrame: (frame, hello, reply) =>
      frame.type === "hello"
        ? undefined
        : routeLocal(frame, hello, reply, {
            agents,
            hub: { send: (f) => sendToHub(f) },
            pending,
            limited: (ref) =>
              limited.has(ref) ? (caps.get(ref) ?? "machine") : undefined,
            // A Pi delivery waits on this same confirmation, from its own session.
            // An ack past Pi's timeout, from the same session, still counts.
            confirm: (msgId, ref) => {
              if (delivery.confirm(msgId, ref)) {
                pi.acked(msgId, ref);
                return true;
              }
              if (!pi.lateAck(msgId, ref)) return false;
              delivery.delivered(msgId);
              return true;
            },
          }),
    onOpen: (hello, push) => {
      if (hello.kind !== "pi") return;
      const links = piLinks.get(hello.agent_ref) ?? new Map();
      links.set(hello, push);
      piLinks.set(hello.agent_ref, links);
      tellOwed(hello.agent_ref);
    },
    onClose: (hello) => {
      if (!hello) return;
      const links = piLinks.get(hello.agent_ref);
      links?.delete(hello);
      if (links?.size === 0) {
        piLinks.delete(hello.agent_ref);
        pi.dropRef(hello.agent_ref);
      }
      const left = (conns.get(hello.agent_ref) ?? 1) - 1;
      if (left > 0) {
        conns.set(hello.agent_ref, left);
        return;
      }
      conns.delete(hello.agent_ref);
      // Only pi lives as long as its connection. Claude's MCP server connects
      // per tool call (its liveness is the session files); OpenCode's is presence.
      if (hello.kind !== "pi") return;
      const rec = agents.byRef(hello.agent_ref);
      if (!rec) return;
      rec.live = false;
      announceSessions();
    },
  }).catch(socketInUse);
  // A cleaner or a hand may remove the socket: adapters would get ENOENT forever.
  const bound = lstatSync(listenPath);
  const socketWatch = setInterval(() => {
    let now: ReturnType<typeof lstatSync> | undefined;
    try {
      now = lstatSync(listenPath);
    } catch {}
    if (now?.ino === bound.ino && now.dev === bound.dev) return;
    clearInterval(socketWatch);
    log(`the daemon socket ${listenPath} was removed or replaced`);
    deps.onSocketLost?.();
  }, deps.socketCheckMs ?? 60_000);
  socketWatch.unref();

  const sync = () => {
    for (const [what, fn] of [
      ["claude", syncClaude],
      ["opencode", syncOpenCode],
    ] as const) {
      try {
        fn();
      } catch (e) {
        log(
          `${what} session sync failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  };
  sync();
  const watcher = setInterval(sync, cl.syncMs ?? 2000);
  watcher.unref();
  // A notice that failed for a live sender is retried; `tell` keeps one in flight per entry.
  const retry = setInterval(() => {
    for (const a of agents.all()) if (a.live) tellOwed(a.ref);
  }, NOTICE_RETRY_MS);
  retry.unref();

  // After the socket is up, so `open-bus install` sees the daemon at once.
  const ocVersion = await (
    oc.version ?? (() => opencodeVersion(spawnExec(ocSpawn)))
  )().catch(() => undefined);
  promptIdSupported = supportsPromptId(ocVersion);
  if (!promptIdSupported)
    log(
      `OpenCode ${ocVersion ?? "(version unknown)"} is below ${MIN_PROMPT_ID_VERSION}: a timed-out prompt is never retried`,
    );
  hub.start();
  return {
    hub,
    agents,
    stop: async () => {
      clearInterval(socketWatch);
      clearInterval(watcher);
      clearInterval(retry);
      outbox.stop();
      for (const t of limited.values()) clearTimeout(t);
      hub.stop();
      pending.failAll("hub_unavailable", "the daemon is stopping");
      sent.flush();
      await Promise.all([server.close(), claude.close()]);
    },
  };
}
