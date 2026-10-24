// An in-process stand-in for the hub, for the harness self-test only. It speaks
// the F2 wire frames from @ob/shared (every frame in is decoded, every frame out
// is parsed by the schema) and the device-flow REST shapes. Its routing is the
// minimum the self-test needs; the real semantics are the hub's (02-backend).
import { createServer, type IncomingMessage } from "node:http";
import {
  ApprovalBodySchema,
  type ClientFrame,
  CSRF_HEADER,
  CSRF_VALUE,
  candidateName,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  decodeClientFrame,
  encodeFrame,
  formatUserCode,
  frameId,
  LIMITS,
  newDeviceSecret,
  newId,
  newMachineToken,
  newMsgId,
  newUserCode,
  PING,
  PONG,
  R,
  type ServerFrame,
  ServerFrameSchema,
  suffixName,
  utf8Bytes,
  utf8Exceeds,
} from "@ob/shared";
import { type WebSocket, WebSocketServer } from "ws";

type Agent = {
  machine_id: string;
  agent_ref: string;
  kind: "claude-code" | "opencode" | "pi";
  name: string;
  namespace: string;
  global: boolean;
  open: boolean;
};

export type FakeHub = {
  url: string;
  /** Session cookie the fake approve and revoke routes accept. */
  cookie: string;
  connected: () => string[];
  tokens: () => string[];
  revoked: () => string[];
  /** Marks a machine revoked without closing its socket (the daemon never hears). */
  revokeOffline: (machineId: string) => Promise<void>;
  /** Requests that reached `DELETE /__e2e/machine/:id`. */
  seedDeletes: () => number;
  agents: () => Agent[];
  close: () => Promise<void>;
};

type Body = Record<string, unknown> | undefined;
const readText = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => resolve(s));
  });
const readJson = (req: IncomingMessage): Promise<Body> =>
  new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });

export async function fakeHub(
  /** `seedRevoke: false` leaves out `DELETE /__e2e/machine/:id`, as before B9. */
  o: { seedRevoke?: boolean } = {},
): Promise<FakeHub> {
  const cookie = `ob_session=${newId()}`;
  const devices = new Map<
    string,
    { user: string; label: string; approved: boolean }
  >();
  const machines = new Map<
    string,
    { token: string; label: string; revoked: boolean }
  >();
  const sockets = new Map<string, WebSocket>();
  let seedDeleteCount = 0;
  const agents: Agent[] = [];
  /** Undelivered mail: pushed but unacked, or queued for a disconnected machine. */
  const mail = new Map<
    string,
    {
      from: string;
      to: Agent;
      deliver: Extract<ServerFrame, { type: "deliver" }>;
    }
  >();

  /** Oversized bodies, kept for `fetch`. */
  const bodies = new Map<string, { to: Agent; body: string }>();
  const push = (machineId: string, frame: ServerFrame) => {
    const ws = sockets.get(machineId);
    ws?.send(encodeFrame(ServerFrameSchema.parse(frame)));
  };
  const update = (
    machineId: string,
    msg_id: string,
    state: "delivered" | "expired" | "refused",
    reason?: string,
  ) =>
    push(machineId, {
      v: 1,
      id: frameId(),
      type: "receipt_update",
      msg_id,
      state,
      ...(reason ? { reason } : {}),
    } as ServerFrame);
  const visible = (from: Agent, to: Agent) =>
    from.namespace === to.namespace || from.global || to.global;
  const revoked = (a: Agent) => machines.get(a.machine_id)?.revoked === true;
  /** Last reported open; `queued` while its machine is away. */
  const listed = (a: Agent) => a.open && !revoked(a);

  /** On reconnect: expire mail for sessions now closed, push the rest again. */
  function flush(machineId: string) {
    for (const [id, m] of mail) {
      if (m.to.machine_id !== machineId) continue;
      if (!m.to.open) {
        mail.delete(id);
        update(m.from, id, "expired", "recipient_closed");
      } else push(machineId, m.deliver);
    }
  }

  /**
   * The send-target rules pinned on `send` in @ob/shared (#85/#94): a
   * non-global sender reaches its own namespace, then globals, and with
   * `to_namespace` another namespace only for a global agent; a global sender
   * reaches the name in `to_namespace`, else a global agent or the one
   * namespace holding the name, and two or more namespaces are `ambiguous`.
   */
  function resolve(me: Agent, name: string, toNs?: string): Agent | string {
    // One agent per (namespace, name): an open one wins over a closed one.
    const byNs = new Map<string, Agent>();
    for (const a of agents.filter((x) => x.name === name))
      if (!byNs.get(a.namespace)?.open) byNs.set(a.namespace, a);
    const all = [...byNs.values()];
    const known = all.length ? "other_namespace" : "unknown_agent";
    const global = all.find((a) => a.global);
    if (!me.global) {
      if (toNs === undefined || toNs === me.namespace) {
        const own = byNs.get(me.namespace);
        if (own) return own;
        // Other namespaces are invisible: no other_namespace without to_namespace.
        return global ?? "unknown_agent";
      }
      const there = byNs.get(toNs);
      return there?.global ? there : "other_namespace";
    }
    if (toNs !== undefined) return byNs.get(toNs) ?? known;
    if (global) return global;
    if (all.length > 1) return "ambiguous";
    return all[0] ?? "unknown_agent";
  }

  function onFrame(machineId: string, f: ClientFrame) {
    const reply = (frame: Record<string, unknown>) =>
      push(machineId, { v: 1, id: f.id, ...frame } as ServerFrame);
    const self = (ref: string) =>
      agents.find((a) => a.machine_id === machineId && a.agent_ref === ref);
    switch (f.type) {
      case "hello":
        reply({
          type: "hello_ok",
          machine_id: machineId,
          machine_label: f.machine_label,
          server_version: "fake",
        });
        return;
      case "agent_up": {
        let a = self(f.agent_ref);
        if (!a) {
          a = {
            machine_id: machineId,
            agent_ref: f.agent_ref,
            kind: f.kind,
            name: "",
            namespace: f.namespace,
            global: f.global,
            open: true,
          };
          agents.push(a);
        }
        Object.assign(a, {
          open: true,
          namespace: f.namespace,
          global: f.global,
        });
        const base = candidateName(f.proposed_name);
        const taken = (n: string) =>
          agents.some(
            (o) =>
              o !== a && o.open && o.namespace === a.namespace && o.name === n,
          );
        let name = base;
        for (let i = 2; taken(name); i++) name = suffixName(base, i);
        a.name = name;
        reply({ type: "agent_ok", agent_ref: a.agent_ref, bus_name: name });
        return;
      }
      case "agent_down": {
        const a = self(f.agent_ref);
        if (a) a.open = false;
        return;
      }
      case "sessions":
        for (const a of agents.filter((x) => x.machine_id === machineId))
          a.open = f.open.includes(a.agent_ref);
        flush(machineId);
        return;
      case "list": {
        const me = self(f.from_ref);
        if (!me)
          return reply({
            type: "error",
            code: "not_registered",
            message: "unknown from_ref",
          });
        reply({
          type: "roster",
          agents: agents
            .filter((a) => listed(a) && visible(me, a))
            .map((a) => ({
              bus_name: a.name,
              kind: a.kind,
              namespace: a.namespace,
              global: a.global,
              state: sockets.has(a.machine_id) ? "live" : "queued",
            })),
        });
        return;
      }
      case "send": {
        const me = self(f.from_ref);
        if (!me)
          return reply({
            type: "error",
            code: "not_registered",
            message: "unknown from_ref",
          });
        const msg_id = newMsgId();
        const refuse = (reason: string) =>
          reply({ type: "receipt", msg_id, state: "refused", reason });
        const to = resolve(me, f.to_name, f.to_namespace);
        if (typeof to === "string") return refuse(to);
        if (revoked(to)) return refuse("revoked");
        if (!to.open) return refuse("closed");
        const deliver: Extract<ServerFrame, { type: "deliver" }> = {
          v: 1 as const,
          id: frameId(),
          type: "deliver" as const,
          msg_id,
          to_ref: to.agent_ref,
          from_name: me.name,
          namespace: me.namespace,
          ...(utf8Exceeds(f.body, LIMITS.inlineBodyBytes)
            ? { notice: { size: utf8Bytes(f.body), msg_id } }
            : { body: f.body }),
        };
        if (deliver.notice) bodies.set(msg_id, { to, body: f.body });
        mail.set(msg_id, { from: machineId, to, deliver });
        reply({ type: "receipt", msg_id, state: "pending" });
        push(to.machine_id, deliver);
        return;
      }
      case "ack":
      case "refuse": {
        const m = mail.get(f.msg_id);
        // Only the machine the mail went to may settle it.
        if (!m || m.to.machine_id !== machineId) return;
        mail.delete(f.msg_id);
        if (f.type === "ack") update(m.from, f.msg_id, "delivered");
        else update(m.from, f.msg_id, "refused", f.reason);
        return;
      }
      case "fetch": {
        const me = self(f.from_ref);
        const kept = bodies.get(f.msg_id);
        // Not addressed to this agent reads exactly like an unknown id.
        if (!me || !kept || kept.to !== me)
          return reply({
            type: "error",
            code: "not_found",
            message: "no such message",
          });
        bodies.delete(f.msg_id);
        reply({ type: "body", msg_id: f.msg_id, body: kept.body });
        return;
      }
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    // As the hub's csrfRefusal: the session cookie, the CSRF header and a
    // same-origin Origin.
    const authed = () =>
      req.headers.cookie === cookie &&
      req.headers[CSRF_HEADER.toLowerCase()] === CSRF_VALUE &&
      req.headers.origin === origin();

    if (req.method === "POST" && url.pathname === R.deviceCode) {
      const body = await readJson(req);
      const user = formatUserCode(newUserCode());
      const device_code = newDeviceSecret();
      devices.set(device_code, {
        user,
        label: String(body?.machine_label ?? "machine"),
        approved: false,
      });
      return json(
        200,
        DeviceCodeResponseSchema.parse({
          device_code,
          user_code: user,
          verification_uri: `${origin()}${R.approve(user)}`,
          expires_in: LIMITS.deviceCodeTtlSec,
          interval: LIMITS.devicePollIntervalSec,
        }),
      );
    }
    // The local-only seed route of `wrangler dev -c wrangler.e2e.jsonc` (#115).
    // Like the real entry: the seed routes answer only a loopback URL host.
    const loopbackHost = () => {
      try {
        return ["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(`http://${req.headers.host ?? ""}`).hostname,
        );
      } catch {
        return false;
      }
    };
    if (url.pathname.startsWith("/__e2e/") && !loopbackHost())
      return json(403, { code: "forbidden" });
    if (req.method === "POST" && url.pathname === "/__e2e/machine") {
      if (req.headers["x-ob-e2e"] !== "1")
        return json(403, { code: "forbidden" });
      const body = await readJson(req);
      const label = String(body?.label ?? "e2e");
      const machine_id = newId();
      const machine_token = newMachineToken();
      machines.set(machine_id, { token: machine_token, label, revoked: false });
      return json(200, { hub: origin(), machine_id, label, machine_token });
    }
    if (req.method === "POST" && url.pathname === R.deviceToken) {
      const parsed = DeviceTokenRequestSchema.safeParse(await readJson(req));
      const d = parsed.success
        ? devices.get(parsed.data.device_code)
        : undefined;
      if (!parsed.success || !d) return json(400, { error: "bad device code" });
      if (!d.approved)
        return json(
          200,
          DeviceTokenResponseSchema.parse({ status: "pending" }),
        );
      devices.delete(parsed.data.device_code);
      const machine_id = newId();
      const token = newMachineToken();
      machines.set(machine_id, { token, label: d.label, revoked: false });
      return json(
        200,
        DeviceTokenResponseSchema.parse({
          status: "approved",
          token,
          machine_id,
        }),
      );
    }
    // B4's approval page: a classic form POST, same-origin, carrying the page's
    // signed token in `csrf`; no CSRF header. Approve answers 303.
    const approve = /^\/approve\/([^/]+)$/.exec(url.pathname);
    const pageToken = (code: string) => `fake-csrf-${code}`;
    if (req.method === "GET" && approve) {
      if (req.headers.cookie !== cookie)
        return json(403, { error: "forbidden" });
      const code = decodeURIComponent(approve[1] ?? "");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<form method="post"><input type="hidden" name="csrf" value="${pageToken(code)}"></form>`,
      );
      return;
    }
    if (req.method === "POST" && approve) {
      const code = decodeURIComponent(approve[1] ?? "");
      const form = new URLSearchParams(await readText(req));
      if (
        req.headers.cookie !== cookie ||
        req.headers.origin !== origin() ||
        !/^application\/x-www-form-urlencoded/.test(
          req.headers["content-type"] ?? "",
        ) ||
        form.get("csrf") !== pageToken(code)
      )
        return json(403, { error: { code: "csrf" } });
      const body = ApprovalBodySchema.safeParse({
        decision: form.get("decision"),
      });
      const d = [...devices.values()].find((x) => x.user === code);
      if (!body.success || !d) return json(404, { error: "not found" });
      d.approved = body.data.decision === "approve";
      res.writeHead(303, { location: "/" });
      res.end();
      return;
    }
    /** The one hub revoke path both routes call. False for an unknown id. */
    const revokeMachine = (id: string): boolean => {
      const m = machines.get(id);
      if (!m || m.revoked) return false;
      m.revoked = true;
      sockets.get(id)?.close(LIMITS.revokeCloseCode, "revoked");
      return true;
    };
    const revoke = /^\/api\/v1\/machines\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && revoke) {
      if (!authed()) return json(403, { error: "forbidden" });
      return revokeMachine(revoke[1] ?? "")
        ? json(204)
        : json(404, { error: "not found" });
    }
    // The local e2e entry's planned seed revoke (waits on B9).
    const seedRevoke = /^\/__e2e\/machine\/([^/]+)$/.exec(url.pathname);
    if (o.seedRevoke !== false && req.method === "DELETE" && seedRevoke) {
      seedDeleteCount++;
      if (req.headers["x-ob-e2e"] !== "1")
        return json(403, { code: "forbidden" });
      return revokeMachine(decodeURIComponent(seedRevoke[1] ?? ""))
        ? json(204)
        : json(404, { code: "not_found" });
    }
    if (url.pathname === R.hub) return json(426, { error: "upgrade required" });
    // The real Worker's generic 404 shape.
    return json(404, {
      error: { code: "not_found", message: "Not found" },
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const url = new URL(req.url ?? "/", "http://x");
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const entry = [...machines.entries()].find(
      ([, m]) => m.token === token && !m.revoked,
    );
    if (url.pathname !== R.hub || !entry) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const [machineId] = entry;
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.get(machineId)?.close(1000, "replaced");
      sockets.set(machineId, ws);
      ws.on("error", () => {
        /* close follows */
      });
      ws.on("message", (data) => {
        const text = String(data);
        if (text === PING) return ws.send(PONG);
        const r = decodeClientFrame(text);
        if (!r.ok) return ws.close(LIMITS.protocolCloseCode, r.error);
        onFrame(machineId, r.frame);
      });
      ws.on("close", () => {
        if (sockets.get(machineId) === ws) sockets.delete(machineId);
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = () =>
    `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url: origin(),
    cookie,
    connected: () => [...sockets.keys()],
    tokens: () => [...machines.values()].map((m) => m.token),
    revokeOffline: async (id) => {
      const m = machines.get(id);
      if (m) m.revoked = true;
    },
    seedDeletes: () => seedDeleteCount,
    revoked: () =>
      [...machines.entries()].filter(([, m]) => m.revoked).map(([id]) => id),
    agents: () => agents.map((a) => ({ ...a })),
    close: async () => {
      for (const ws of sockets.values()) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
