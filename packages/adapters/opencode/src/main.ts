import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { connectDaemon } from "@ob/ipc";
import { opencodeApi, rootSession } from "./session.ts";
import { handleToolCall, TOOLS } from "./tools.ts";

const SOCKET = join(
  process.env.OPENBUS_HOME ?? join(homedir(), ".openbus"),
  "daemon.sock",
);

const server = new Server(
  { name: "openbus", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS],
}));
server.setRequestHandler(CallToolRequestSchema, (req) =>
  handleToolCall({
    name: req.params.name,
    args: (req.params.arguments ?? {}) as Record<string, unknown>,
    meta: req.params._meta as Record<string, unknown> | undefined,
    connect: (hello) => connectDaemon({ path: SOCKET, hello }),
    resolve: (id) => rootSession(id, { api: opencodeApi }),
  }),
);

await server.connect(new StdioServerTransport());
