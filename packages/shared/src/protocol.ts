import { z } from "zod";
import { newId } from "./ids.js";
import { AgentKindSchema } from "./kinds.js";
import { LIMITS, utf8Exceeds } from "./limits.js";
import { BusNameSchema } from "./names.js";
import { NamespaceSchema } from "./namespace.js";
import {
  MsgIdSchema,
  receiptReasonMatchesState,
  receiptShape,
} from "./receipts.js";
import { AgentRefSchema, MachineLabelSchema } from "./refs.js";

export const PROTOCOL_VERSION = 1;

const FrameIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const base = { v: z.literal(1), id: FrameIdSchema } as const;

/** One JSON object per WebSocket message. Bodies are capped in UTF-8 bytes. */
const BodySchema = z
  .string()
  .refine((s) => !utf8Exceeds(s, LIMITS.maxMessageBytes), "body too large");
const InlineBodySchema = z
  .string()
  .refine(
    (s) => !utf8Exceeds(s, LIMITS.inlineBodyBytes),
    "inline body too large",
  );
const MAX_LIST = 1000;
const distinct = (a: string[]) => new Set(a).size === a.length;

const Hello = z.strictObject({
  ...base,
  type: z.literal("hello"),
  machine_label: MachineLabelSchema,
  client_version: z.string().min(1).max(64),
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

const Sessions = z
  .strictObject({
    ...base,
    type: z.literal("sessions"),
    open: z.array(AgentRefSchema).max(MAX_LIST),
    closed: z.array(AgentRefSchema).max(MAX_LIST),
  })
  .refine(
    (f) =>
      distinct(f.open) &&
      distinct(f.closed) &&
      !f.open.some((r) => f.closed.includes(r)),
    "duplicate or overlapping session refs",
  );

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
  machine_label: z.string().max(1024),
  server_version: z.string().max(1024),
});

const AgentOk = z.strictObject({
  ...base,
  type: z.literal("agent_ok"),
  agent_ref: AgentRefSchema,
  bus_name: BusNameSchema,
});

/** The reply to `send`: only `pending` or `refused`, never a false `delivered`. */
const ReceiptFrame = z
  .strictObject({ ...base, type: z.literal("receipt"), ...receiptShape })
  .refine(receiptReasonMatchesState, "reason does not match state")
  .refine(
    (f) => f.state === "pending" || f.state === "refused",
    "send receipt is pending or refused",
  );

const RosterAgent = z.strictObject({
  bus_name: BusNameSchema,
  kind: AgentKindSchema,
  namespace: NamespaceSchema,
  global: z.boolean(),
});
const Roster = z.strictObject({
  ...base,
  type: z.literal("roster"),
  agents: z.array(RosterAgent).max(MAX_LIST),
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
  message: z.string().max(1024),
});

const Notice = z.strictObject({
  size: z.number().int().gt(LIMITS.inlineBodyBytes).max(LIMITS.maxMessageBytes),
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
    body: InlineBodySchema.optional(),
    notice: Notice.optional(),
  })
  .refine(
    (f) => (f.body === undefined) !== (f.notice === undefined),
    "body xor notice",
  )
  .refine(
    (f) => f.notice === undefined || f.notice.msg_id === f.msg_id,
    "notice msg_id mismatch",
  );

const ReceiptUpdate = z
  .strictObject({ ...base, type: z.literal("receipt_update"), ...receiptShape })
  .refine(receiptReasonMatchesState, "reason does not match state");

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

/** Serializes a frame with `v` then `id` first, so an oversize id is recoverable. */
export function encodeFrame(frame: Frame): string {
  const { v, id, ...rest } = frame;
  return JSON.stringify({ v, id, ...rest });
}

/** Correlation id for a new request or unsolicited push. */
export function frameId(): string {
  return newId();
}

export type DecodeResult<F> =
  | { ok: true; frame: F }
  | { ok: false; error: "bad_frame" | "too_large"; id?: string };

/**
 * Wire limits: a body is at most 1 MB of UTF-8 (`maxMessageBytes`), which is at
 * most 2 MB as JSON text once escaped (worst case about 2 chars per byte for
 * quotes and newlines; control characters are rarer but 6 chars each, so the
 * raw cap is 2 MB + 4 KB and the body is re-measured after parsing).
 */
export const MAX_RAW_FRAME_CHARS = 2 * LIMITS.maxMessageBytes + 4096;
const MAX_DEPTH = 4;
const MAX_TOKENS = 4096;
const STRING_RE = /"[^"\\]*(?:\\[\s\S][^"\\]*)*"/y;
const MAX_STRUCTURAL = 65536;
const ID_PREFIX_RE = /^\s*\{"v":1,"id":"([A-Za-z0-9_-]{1,64})"/;

function recoverId(raw: string): string | undefined {
  return ID_PREFIX_RE.exec(raw.slice(0, 96))?.[1];
}

/**
 * One pass, ignoring string contents: false when nesting is deeper than
 * MAX_DEPTH or there are more than MAX_TOKENS `:` and `,` outside strings.
 * Bounds JSON.parse and zod's unknown-key scan on hostile input.
 */
function structureOk(raw: string): boolean {
  let depth = 0;
  let tokens = 0;
  let matches = 0;
  const re = /["{}[\]:,]/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    if (++matches > MAX_STRUCTURAL) return false;
    const c = m[0];
    if (c === '"') {
      // skip the whole string (unrolled loop: linear, no backtracking blowup)
      STRING_RE.lastIndex = m.index;
      if (!STRING_RE.test(raw)) return false;
      re.lastIndex = STRING_RE.lastIndex;
    } else if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) return false;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (++tokens > MAX_TOKENS) return false;
  }
  return true;
}

function decode<F>(raw: unknown, schema: z.ZodType<F>): DecodeResult<F> {
  if (typeof raw !== "string") return { ok: false, error: "bad_frame" };
  if (raw.length > MAX_RAW_FRAME_CHARS) {
    const id = recoverId(raw);
    return id
      ? { ok: false, error: "too_large", id }
      : { ok: false, error: "too_large" };
  }
  if (!structureOk(raw)) return { ok: false, error: "bad_frame" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_frame" };
  }
  let id: string | undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.id === "string" && FrameIdSchema.safeParse(o.id).success)
      id = o.id;
    if (
      typeof o.body === "string" &&
      utf8Exceeds(o.body, LIMITS.maxMessageBytes)
    ) {
      return id
        ? { ok: false, error: "too_large", id }
        : { ok: false, error: "too_large" };
    }
  }
  const r = schema.safeParse(value);
  if (r.success) return { ok: true, frame: r.data };
  return id
    ? { ok: false, error: "bad_frame", id }
    : { ok: false, error: "bad_frame" };
}

/** Hub side: accepts only daemon-to-hub frames. Never throws. */
export function decodeClientFrame(raw: unknown): DecodeResult<ClientFrame> {
  return decode(raw, ClientFrameSchema);
}

/** Daemon side: accepts only hub-to-daemon frames. Never throws. */
export function decodeServerFrame(raw: unknown): DecodeResult<ServerFrame> {
  return decode(raw, ServerFrameSchema);
}

export function formatFrameError(
  message: string,
  frameId: string | null,
): string {
  return frameId ? `${message} (frame ${frameId})` : message;
}
