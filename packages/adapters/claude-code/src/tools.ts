import type { DaemonClient } from "@ob/ipc";

const none = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const TOOLS = [
  {
    name: "list_agents",
    description: "List the agents you can message, in your OpenBus namespace.",
    inputSchema: none,
  },
  {
    name: "send_message",
    description: "Send a message to another agent by name.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, text: { type: "string" } },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch",
    description: "Fetch the full body of an oversized message by id.",
    inputSchema: {
      type: "object",
      properties: { msg_id: { type: "string" } },
      required: ["msg_id"],
      additionalProperties: false,
    },
  },
  {
    name: "self",
    description: "Your own OpenBus agent entry and bus name.",
    inputSchema: none,
  },
] as const;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const text = (t: string, isError?: boolean): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError === undefined ? {} : { isError }),
});

/** The sender is the connection's attested session; a `from` argument is never read. */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  client: DaemonClient,
): Promise<ToolResult> {
  try {
    if (name === "list_agents") {
      const r = await client.request({ type: "list" });
      if (r.type !== "roster") return failed(r);
      return text(
        r.agents.length
          ? r.agents
              .map(
                (a) =>
                  `- ${a.name} (${a.kind}, ${a.namespace}${a.live ? "" : ", closed"})`,
              )
              .join("\n")
          : "No agents in your namespace.",
      );
    }
    if (name === "send_message") {
      const to = String(args.to ?? "");
      const body = String(args.text ?? "");
      if (!to || !body) return text("openbus: to and text are required", true);
      const r = await client.request({ type: "send", to, body });
      if (r.type !== "receipt") return failed(r);
      return r.state === "refused"
        ? text(`Refused: ${r.reason ?? "unknown"}`, true)
        : text(`Delivery ${r.state}.`, false);
    }
    if (name === "fetch") {
      const r = await client.request({
        type: "fetch",
        msg_id: String(args.msg_id ?? ""),
      });
      return r.type === "body" ? text(r.body, false) : failed(r);
    }
    if (name === "self") {
      const r = await client.request({ type: "self" });
      if (r.type !== "agent") return failed(r);
      return text(JSON.stringify(r.agent, null, 2));
    }
    return text(`openbus: unknown tool ${name}`, true);
  } catch (e) {
    // A daemon that is down must not take the MCP server with it.
    return text(`openbus: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

function failed(r: { type: string; message?: string }): ToolResult {
  return text(`openbus: ${r.type === "error" ? r.message : r.type}`, true);
}
