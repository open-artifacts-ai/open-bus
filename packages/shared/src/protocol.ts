import { z } from "zod";
import { newId } from "./ids.js";
import { AgentKindSchema } from "./kinds.js";
import { LIMITS, utf8Exceeds } from "./limits.js";
import { BusNameSchema } from "./names.js";
import { NamespaceSchema } from "./namespace.js";
import {
  MsgIdSchema,
  ReceiptReasonSchema,
  ReceiptStateSchema,
} from "./receipts.js";
import { AgentRefSchema } from "./refs.js";

export const PROTOCOL_VERSION = 1;

const FrameIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const base = { v: z.literal(1), id: FrameIdSchema } as const;

/** One JSON object per WebSocket message. Bodies are capped in UTF-8 bytes. */
const BodySchema = z
  .string()
  .refine((s) => !utf8Exceeds(s, LIMITS.maxMessageBytes), "body too large");

const Hello = z.strictObject({
  ...base,
  type: z.literal("hello"),
  machine_label: z.string().min(1).max(LIMITS.maxLabelChars),
  client_version: z.string().min(1).max(32),
});

const AgentUp = z.strictObject({
  ...base,
  type: z.literal("agent_up"),
  agent_ref: AgentRefSchema,
  kind: AgentKindSchema,
  proposed_name: z.string().max(256),
  namespace: NamespaceSchema,
  global: z.boolean(),
});

const AgentDown = z.strictObject({
  ...base,
  type: z.literal("agent_down"),
  agent_ref: AgentRefSchema,
});

const Sessions = z.strictObject({
  ...base,
  type: z.literal("sessions"),
  open: z.array(AgentRefSchema).max(64),
  closed: z.array(AgentRefSchema).max(64),
});

const Send = z.strictObject({
  ...base,
  type: z.literal("send"),
  from_ref: AgentRefSchema,
  to_name: BusNameSchema,
  body: BodySchema,
});

const Ack = z.strictObject({
  ...base,
  type: z.literal("ack"),
  msg_id: MsgIdSchema,
});

/**
 * The harness did not take the message (Claude `peer_message_status`, a failed
 * prompt, a dead session). `held` is not a refusal: the daemon sends nothing
 * and keeps waiting. `reason` is fixed to `closed` — the spec's pinned refusal
 * reason for "the session could not take it".
 */
const Refuse = z.strictObject({
  ...base,
  type: z.literal("refuse"),
  msg_id: MsgIdSchema,
  reason: z.literal("closed"),
  detail: z.enum(["denied", "refused", "expired", "dropped"]),
});
const List = z.strictObject({
  ...base,
  type: z.literal("list"),
  from_ref: AgentRefSchema,
});
const Fetch = z.strictObject({
  ...base,
  type: z.literal("fetch"),
  from_ref: AgentRefSchema,
  msg_id: MsgIdSchema,
});

const HelloOk = z.strictObject({
  ...base,
  type: z.literal("hello_ok"),
  machine_id: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{16}$/),
  machine_label: z.string(),
  server_version: z.string(),
});

const AgentOk = z.strictObject({
  ...base,
  type: z.literal("agent_ok"),
  agent_ref: AgentRefSchema,
  bus_name: BusNameSchema,
});

const ReceiptFrame = z.strictObject({
  ...base,
  type: z.literal("receipt"),
  msg_id: MsgIdSchema,
  state: ReceiptStateSchema,
  reason: ReceiptReasonSchema.optional(),
});

const RosterAgent = z.strictObject({
  bus_name: BusNameSchema,
  kind: AgentKindSchema,
  namespace: NamespaceSchema,
  global: z.boolean(),
});
const Roster = z.strictObject({
  ...base,
  type: z.literal("roster"),
  agents: z.array(RosterAgent).max(500),
});

const BodyFrame = z.strictObject({
  ...base,
  type: z.literal("body"),
  msg_id: MsgIdSchema,
  body: BodySchema,
});

const ErrorFrame = z.strictObject({
  ...base,
  type: z.literal("error"),
  code: z.enum([
    "bad_frame",
    "not_registered",
    "not_found",
    "too_large",
    "rate_limited",
    "internal",
  ]),
  message: z.string().max(200),
});

const Notice = z.strictObject({
  size: z.number().int().positive(),
  msg_id: MsgIdSchema,
});

const Deliver = z
  .strictObject({
    ...base,
    type: z.literal("deliver"),
    msg_id: MsgIdSchema,
    to_ref: AgentRefSchema,
    from_name: BusNameSchema,
    namespace: NamespaceSchema,
    body: BodySchema.optional(),
    notice: Notice.optional(),
  })
  .refine(
    (f) => (f.body === undefined) !== (f.notice === undefined),
    "body xor notice",
  );

const ReceiptUpdate = z.strictObject({
  ...base,
  type: z.literal("receipt_update"),
  msg_id: MsgIdSchema,
  state: ReceiptStateSchema,
  reason: ReceiptReasonSchema.optional(),
});

const RosterChanged = z.strictObject({
  ...base,
  type: z.literal("roster_changed"),
  namespace: NamespaceSchema,
});

export const CLIENT_FRAMES = [
  "hello",
  "agent_up",
  "agent_down",
  "sessions",
  "send",
  "ack",
  "refuse",
  "list",
  "fetch",
] as const;
export const SERVER_FRAMES = [
  "hello_ok",
  "agent_ok",
  "receipt",
  "roster",
  "body",
  "error",
  "deliver",
  "receipt_update",
  "roster_changed",
] as const;

export const ClientFrameSchema = z.discriminatedUnion("type", [
  Hello,
  AgentUp,
  AgentDown,
  Sessions,
  Send,
  Ack,
  Refuse,
  List,
  Fetch,
]);
export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloOk,
  AgentOk,
  ReceiptFrame,
  Roster,
  BodyFrame,
  ErrorFrame,
  Deliver,
  ReceiptUpdate,
  RosterChanged,
]);
export const FrameSchema = z.discriminatedUnion("type", [
  Hello,
  AgentUp,
  AgentDown,
  Sessions,
  Send,
  Ack,
  Refuse,
  List,
  Fetch,
  HelloOk,
  AgentOk,
  ReceiptFrame,
  Roster,
  BodyFrame,
  ErrorFrame,
  Deliver,
  ReceiptUpdate,
  RosterChanged,
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type AgentUpFrame = z.infer<typeof AgentUp>;
export type SendFrame = z.infer<typeof Send>;
export type DeliverFrame = z.infer<typeof Deliver>;
export type RefuseFrame = z.infer<typeof Refuse>;

/** Serializes a frame the caller has already built from a schema. */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Correlation id for a new request or unsolicited push. */
export function frameId(): string {
  return newId();
}

/**
 * Never throws. Anything over the read cap is refused before JSON.parse, so a
 * hostile 1 GB frame costs one length check. Bare "ping"/"pong" are not frames.
 */
export function decodeFrame(raw: string): Frame | null {
  if (raw.length > LIMITS.maxMessageBytes + 2048) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = FrameSchema.safeParse(value);
  return r.success ? r.data : null;
}

export function formatFrameError(
  message: string,
  frameId: string | null,
): string {
  return frameId ? `${message} (frame ${frameId})` : message;
}
