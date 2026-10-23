// TODO(F2.3): replace with @ob/shared wire frames
import {
  AGENT_REF,
  INLINE_CAP_BYTES,
  KIND,
  MAX_BODY_BYTES,
  REFUSAL,
} from "@ob/ipc";
import { z } from "zod";

const base = { v: z.literal(1), id: z.string().min(1).max(64) };
const MSG_ID = z.string().min(1).max(128);
const NAME = z.string().min(1).max(128);
const STATE = z.enum(["pending", "delivered", "expired", "refused"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const PLAIN = /^[^\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]*$/;

const refs = z
  .array(AGENT_REF)
  .max(1000)
  .refine((a) => new Set(a).size === a.length, { message: "duplicate ref" });

export const DaemonToHub = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("hello"),
    machine_label: z.string().max(128).regex(PLAIN),
    client_version: z.string().min(1).max(64),
  }),
  z.object({
    ...base,
    type: z.literal("agent_up"),
    agent_ref: AGENT_REF,
    kind: KIND,
    proposed_name: z.string().min(1).max(64).optional(),
    namespace: z.string().min(1).max(128),
    global: z.boolean(),
  }),
  z.object({ ...base, type: z.literal("agent_down"), agent_ref: AGENT_REF }),
  z
    .object({
      ...base,
      type: z.literal("sessions"),
      open: refs,
      closed: refs,
    })
    .refine((s) => !s.open.some((r) => s.closed.includes(r)), {
      message: "open and closed overlap",
    }),
  z.object({
    ...base,
    type: z.literal("send"),
    from_ref: AGENT_REF,
    to_name: NAME,
    body: z.string().min(1),
  }),
  z.object({ ...base, type: z.literal("ack"), msg_id: MSG_ID }),
  z.object({ ...base, type: z.literal("list"), from_ref: AGENT_REF }),
  z.object({
    ...base,
    type: z.literal("fetch"),
    from_ref: AGENT_REF,
    msg_id: MSG_ID,
  }),
  z.object({
    ...base,
    type: z.literal("refuse"),
    msg_id: MSG_ID,
    reason: z.literal("closed"),
    detail: z.enum(["held", "denied", "refused", "expired", "dropped"]),
  }),
]);
export type DaemonToHub = z.infer<typeof DaemonToHub>;

const Deliver = z
  .object({
    ...base,
    type: z.literal("deliver"),
    msg_id: MSG_ID,
    to_ref: AGENT_REF,
    from_name: z.string(),
    namespace: z.string(),
    body: z.string().optional(),
    notice: z
      .object({
        size: z.number().int().gt(INLINE_CAP_BYTES).max(MAX_BODY_BYTES),
        msg_id: MSG_ID,
      })
      .optional(),
  })
  .refine((d) => (d.body === undefined) !== (d.notice === undefined), {
    message: "deliver needs exactly one of body or notice",
  })
  .refine((d) => d.notice === undefined || d.notice.msg_id === d.msg_id, {
    message: "notice.msg_id must equal msg_id",
  });

export const HubToDaemon = z.discriminatedUnion("type", [
  Deliver,
  z.object({
    ...base,
    type: z.literal("receipt_update"),
    msg_id: MSG_ID,
    state: STATE,
    reason: REFUSAL.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("receipt"),
    msg_id: MSG_ID,
    state: STATE,
    reason: REFUSAL.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("agent_ok"),
    agent_ref: AGENT_REF,
    bus_name: z.string().min(1),
  }),
  z.object({
    ...base,
    type: z.literal("roster"),
    agents: z.array(
      z.object({
        name: z.string(),
        namespace: z.string(),
        kind: KIND,
        live: z.boolean(),
        global: z.boolean(),
      }),
    ),
  }),
  z.object({
    ...base,
    type: z.literal("body"),
    msg_id: MSG_ID,
    body: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal("roster_changed"),
    namespace: z.string(),
  }),
]);
export type HubToDaemon = z.infer<typeof HubToDaemon>;

export type Decoded =
  | { ok: true; frame: HubToDaemon }
  | { ok: false; error: "bad_frame" | "too_large"; id?: string };

/** Parses one hub->daemon text frame. Never throws. */
export function decodeServerFrame(raw: string): Decoded {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "bad_frame" };
  }
  const id =
    typeof json === "object" &&
    json !== null &&
    typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : undefined;
  const parsed = HubToDaemon.safeParse(json);
  if (!parsed.success) return { ok: false, error: "bad_frame", id };
  const f = parsed.data;
  if (
    f.type === "deliver" &&
    f.body !== undefined &&
    Buffer.byteLength(f.body, "utf8") > INLINE_CAP_BYTES
  ) {
    return { ok: false, error: "too_large", id };
  }
  return { ok: true, frame: f };
}
