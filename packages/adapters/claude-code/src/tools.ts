import { type DaemonClient, excerptOf, receiptText } from "@ob/ipc";

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
      properties: {
        to: { type: "string" },
        text: { type: "string" },
        to_namespace: {
          type: "string",
          description:
            "The recipient's namespace, when a global agent's target name exists in several.",
        },
      },
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

/** Older daemons send only `live`. */
const queued = (a: { live: boolean; state?: "live" | "queued" }) =>
  (a.state ?? (a.live ? "live" : "queued")) === "queued";

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
                  `- ${a.name} (${a.kind}, ${a.namespace}${a.machine_label ? `, ${a.machine_label}` : ""})${queued(a) ? " (queued)" : ""}`,
              )
              .join("\n")
          : "No agents in your namespace.",
      );
    }
    if (name === "send_message") {
      const to = String(args.to ?? "");
      const body = String(args.text ?? "");
      if (!to || !body) return text("openbus: to and text are required", true);
      const namespace =
        typeof args.to_namespace === "string" && args.to_namespace
          ? args.to_namespace
          : undefined;
      const r = await client.request({
        type: "send",
        to,
        body,
        ...(namespace ? { namespace } : {}),
      });
      if (r.type !== "receipt") return failed(r);
      const n =
        r.reason === "ambiguous" ? await namespacesOf(to, client) : undefined;
      return text(
        receiptText(r, to, n, excerptOf(body)),
        r.state === "refused" || r.state === "expired",
      );
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

/** How many namespaces hold `name`; undefined when the roster is unavailable. */
async function namespacesOf(
  name: string,
  client: DaemonClient,
): Promise<number | undefined> {
  try {
    const r = await client.request({ type: "list" });
    if (r.type !== "roster") return undefined;
    return new Set(
      r.agents.filter((a) => a.name === name).map((a) => a.namespace),
    ).size;
  } catch {
    return undefined;
  }
}

function failed(r: { type: string; message?: string }): ToolResult {
  return text(`openbus: ${r.type === "error" ? r.message : r.type}`, true);
}
