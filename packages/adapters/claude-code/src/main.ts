import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon, type DaemonClient } from "@ob/ipc";
import {
  ancestorChain,
  claudeSessionsDir,
  findSession,
  procStartOf,
  sessionHello,
} from "./session.ts";
import { callTool, TOOLS } from "./tools.ts";

const SESSIONS = claudeSessionsDir();
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
      hello: sessionHello(session, process.pid, process.cwd()),
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
