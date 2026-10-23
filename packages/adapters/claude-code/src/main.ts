import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon, type DaemonClient, Hello } from "@ob/ipc";
import { ancestorChain, findSession, procStartOf } from "./session.ts";
import { callTool, TOOLS } from "./tools.ts";

const SESSIONS =
  process.env.OPENBUS_CLAUDE_SESSIONS_DIR ??
  join(homedir(), ".claude", "sessions");
const SOCKET = join(
  process.env.OPENBUS_HOME ?? join(homedir(), ".openbus"),
  "daemon.sock",
);

/** One connection per tool call: the daemon attests the session behind this process. */
async function connect(): Promise<DaemonClient | null> {
  try {
    const session = findSession(process.pid, {
      sessionsDir: SESSIONS,
      ancestors: ancestorChain,
      procStart: procStartOf,
    });
    if (!session) return null;
    return await connectDaemon({
      path: SOCKET,
      hello: Hello.parse({
        v: 1,
        id: "hello",
        type: "hello",
        kind: "claude-code",
        agent_ref: session.sessionId,
        pid: process.pid,
        cwd: process.cwd(),
        proposed_name: session.name.slice(0, 64) || undefined,
        attest: {
          session_id: session.sessionId,
          socket_path: session.socketPath ?? undefined,
        },
      }),
    });
  } catch {
    return null;
  }
}

const server = new Server(
  { name: "openbus", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const client = await connect();
  if (!client) {
    return {
      content: [
        {
          type: "text",
          text: "openbus: no Claude session or daemon found. Run `open-bus install`.",
        },
      ],
      isError: true,
    };
  }
  try {
    return await callTool(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
      client,
    );
  } finally {
    client.close();
  }
});

await server.connect(new StdioServerTransport());
