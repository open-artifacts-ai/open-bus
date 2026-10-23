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
  agents: () => Agent[];
  close: () => Promise<void>;
};

type Body = Record<string, unknown> | undefined;
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

export async function fakeHub(): Promise<FakeHub> {
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
        const named = agents.filter((a) => a.name === f.to_name);
        const matches = named.filter((a) => listed(a) && visible(me, a));
        const to = named.find((a) => visible(me, a));
        const refuse = (reason: string) =>
          reply({ type: "receipt", msg_id, state: "refused", reason });
        if (me.global && matches.length > 1) {
          // Newer than @ob/shared's reasons: sent raw, as a newer hub would.
          sockets.get(machineId)?.send(
            JSON.stringify({
              v: 1,
              id: f.id,
              type: "receipt",
              msg_id,
              state: "refused",
              reason: "ambiguous",
            }),
          );
          return;
        }
        if (!to)
          return refuse(named.length ? "other_namespace" : "unknown_agent");
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
    const authed = () =>
      req.headers.cookie === cookie &&
      req.headers[CSRF_HEADER.toLowerCase()] === CSRF_VALUE;

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
    const approve = /^\/approve\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && approve) {
      if (!authed()) return json(403, { error: "forbidden" });
      const body = ApprovalBodySchema.safeParse(await readJson(req));
      const code = decodeURIComponent(approve[1] ?? "");
      const d = [...devices.values()].find((x) => x.user === code);
      if (!body.success || !d) return json(404, { error: "not found" });
      d.approved = body.data.decision === "approve";
      return json(204);
    }
    const revoke = /^\/api\/v1\/machines\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && revoke) {
      if (!authed()) return json(403, { error: "forbidden" });
      const id = revoke[1] ?? "";
      const m = machines.get(id);
      if (!m || m.revoked) return json(404, { error: "not found" });
      m.revoked = true;
      sockets.get(id)?.close(LIMITS.revokeCloseCode, "revoked");
      return json(204);
    }
    if (url.pathname === R.hub) return json(426, { error: "upgrade required" });
    return json(404, { error: "not found" });
  });

  server.on("upgrade", (req, socket, head) => {
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
