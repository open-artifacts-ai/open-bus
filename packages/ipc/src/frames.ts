import {
  type AgentKind,
  AgentKindSchema,
  AgentRefSchema,
  ReceiptReasonSchema,
} from "@ob/shared";
import { z } from "zod";

export const V = 1 as const;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
export const INLINE_CAP_BYTES = 32 * 1024;

export const KIND = AgentKindSchema;
export type Kind = AgentKind;

/** Stable per-session handle: Claude sessionId, OpenCode root ses_, Pi session id. */
export const AGENT_REF = AgentRefSchema;
export const REFUSAL = z.enum([
  "unknown_agent",
  "closed",
  "inbox_full",
  "too_large",
  "other_namespace",
  "revoked",
]);

const base = { v: z.literal(V), id: z.string().min(1).max(64) };

export const Hello = z.object({
  ...base,
  type: z.literal("hello"),
  kind: KIND,
  agent_ref: AGENT_REF,
  /** The adapter process. The daemon walks its ancestry; it is never trusted alone. */
  pid: z.number().int().positive(),
  cwd: z.string().min(1).max(4096),
  proposed_name: z.string().min(1).max(64).optional(),
  /** What the harness told the adapter, re-checked by the daemon. */
  attest: z
    .object({
      session_id: z.string().optional(),
      socket_path: z.string().optional(),
      proc_start: z.string().optional(),
      tui_pids: z.array(z.number().int().positive()).optional(),
    })
    .default({}),
});
export type Hello = z.infer<typeof Hello>;

export const Send = z.object({
  ...base,
  type: z.literal("send"),
  to: z.string().min(1).max(128),
  body: z
    .string()
    .min(1)
    .refine((b) => Buffer.byteLength(b, "utf8") <= MAX_BODY_BYTES, {
      message: `body exceeds ${MAX_BODY_BYTES} bytes`,
    }),
});
export const List = z.object({ ...base, type: z.literal("list") });
export const Self = z.object({ ...base, type: z.literal("self") });
export const Fetch = z.object({
  ...base,
  type: z.literal("fetch"),
  msg_id: z.string().min(1).max(128),
});
export const Ack = z.object({
  ...base,
  type: z.literal("ack"),
  msg_id: z.string().min(1).max(128),
});

export const AdapterFrame = z.discriminatedUnion("type", [
  Hello,
  Send,
  List,
  Self,
  Fetch,
  Ack,
]);
export type AdapterFrame = z.infer<typeof AdapterFrame>;

export const AgentInfo = z.object({
  name: z.string(),
  namespace: z.string(),
  kind: KIND,
  live: z.boolean(),
  global: z.boolean(),
});

export const Welcome = z.object({
  ...base,
  type: z.literal("welcome"),
  agent_ref: AGENT_REF,
  bus_name: z.string(),
  namespace: z.string(),
  global: z.boolean(),
});
export const Receipt = z.object({
  ...base,
  type: z.literal("receipt"),
  msg_id: z.string(),
  state: z.enum(["pending", "delivered", "expired", "refused"]),
  reason: ReceiptReasonSchema.optional(),
});
export const Roster = z.object({
  ...base,
  type: z.literal("roster"),
  agents: z.array(AgentInfo),
});
export const Agent = z.object({
  ...base,
  type: z.literal("agent"),
  agent: AgentInfo.nullable(),
});
export const Body = z.object({
  ...base,
  type: z.literal("body"),
  msg_id: z.string(),
  body: z.string(),
});
export const Deliver = z
  .object({
    ...base,
    type: z.literal("deliver"),
    msg_id: z.string(),
    from_name: z.string(),
    namespace: z.string(),
    body: z.string().optional(),
    notice: z.object({ size: z.number(), msg_id: z.string() }).optional(),
  })
  .refine((d) => (d.body === undefined) !== (d.notice === undefined), {
    message: "deliver needs exactly one of body or notice",
  });
export const ErrorFrame = z.object({
  ...base,
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const DaemonFrame = z.discriminatedUnion("type", [
  Welcome,
  Receipt,
  Roster,
  Agent,
  Body,
  Deliver,
  ErrorFrame,
]);
export type DaemonFrame = z.infer<typeof DaemonFrame>;
