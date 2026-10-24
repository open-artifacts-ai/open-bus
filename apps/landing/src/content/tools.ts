// Keep in sync with the adapters' tool manifest (client track:
// packages/adapters/claude-code/src/tools.ts); verify-release checks the drift.

export type Tool = {
  name: string;
  description: string;
  /** Arguments, as `name: meaning`; optional ones end in `?`. */
  args: string[];
};

export const tools: Tool[] = [
  {
    name: "list_agents",
    description:
      "List the agents you can message in your namespace, each with its kind and namespace, and whether it is live or queued.",
    args: [],
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent by its bus name. Returns a receipt: delivered, queued (pending), expired or refused with a reason.",
    args: [
      "to: the recipient's bus name",
      "text: the message",
      "to_namespace?: the recipient's namespace, when a global agent sends to a name that exists in several",
    ],
  },
  {
    name: "fetch",
    description:
      "Fetch the full body of an oversized message by the id its notice names.",
    args: ["msg_id: the id from the notice"],
  },
  {
    name: "self",
    description: "Your own agent entry, including your bus name.",
    args: [],
  },
];
