import { z } from "zod";
import { isId, isUserCode, newId } from "./ids.js";
import { AgentKindSchema } from "./kinds.js";
import { LIMITS } from "./limits.js";
import { BusNameSchema } from "./names.js";
import { NamespaceSchema } from "./namespace.js";
import { IdSchema } from "./schemas.js"; // created here: z.string().refine(isId)

/** Session-cookie mutations must carry this header (PAT-free: there are no PATs). */
export const CSRF_HEADER = "X-OB-Request";

const ISO = z.string().datetime({ offset: true });
const seg = (s: string): string => {
  if (s === "." || s === "..")
    throw new RangeError(`Unsafe path segment: ${JSON.stringify(s)}`);
  return encodeURIComponent(s);
};

/** Access OIDC routes the Worker owns (copied from openartifacts). */
export const AUTH = {
  login: "/auth/login",
  callback: "/auth/callback",
  logout: "/auth/logout",
  /** Mounted only when ENVIRONMENT=dev; 404 everywhere else. */
  devLogin: "/auth/dev-login",
} as const;

export const R = {
  healthz: "/healthz",
  deviceCode: "/device/code",
  deviceToken: "/device/token",
  approve: (userCode: string) => `/approve/${seg(userCode)}`,
  me: "/api/v1/me",
  machines: "/api/v1/machines",
  machine: (id: string) => `/api/v1/machines/${seg(id)}`,
  agents: "/api/v1/agents",
  events: "/api/v1/events",
  /** Bearer machine token; WebSocket upgrade. */
  hub: "/hub",
  /** Sign-in entry point (the same URL as AUTH.login; the dashboard links here). */
  login: AUTH.login,
  /** Server-side redirect target once a device code is approved. */
  dashboard: "/machines",
} as const;

/** `{ user: { id, email, name } }`: one owner, so `id` is the constant "owner". */
export const MeSchema = z.strictObject({
  user: z.strictObject({
    id: z.string().min(1).max(32),
    email: z.string().includes("@"),
    name: z.string().nullable(),
  }),
});
export type Me = z.infer<typeof MeSchema>;

/**
 * A machine the owner approved. GET /api/v1/machines lists active and revoked
 * machines, newest first, at most 100; revoked ones carry `revokedAt` (ISO).
 * DELETE /api/v1/machines/:id returns 204 on first revoke and 404 when the
 * machine is unknown or already revoked. `lastUsed` is the last /hub upgrade.
 */
export const MachineSchema = z.strictObject({
  id: IdSchema,
  label: z.string().min(1).max(LIMITS.maxLabelChars),
  createdAt: ISO,
  lastUsed: ISO.nullable(),
  revokedAt: ISO.nullable(),
});
export type Machine = z.infer<typeof MachineSchema>;

export const MachinesResponseSchema = z.strictObject({
  machines: z.array(MachineSchema),
});
export type MachinesResponse = z.infer<typeof MachinesResponseSchema>;

export const AgentSchema = z.strictObject({
  id: IdSchema,
  namespace: NamespaceSchema,
  name: BusNameSchema,
  kind: AgentKindSchema,
  machineId: IdSchema,
  machineLabel: z.string(),
  global: z.boolean(),
  live: z.boolean(),
  updatedAt: ISO,
});
export type Agent = z.infer<typeof AgentSchema>;

export const AgentsResponseSchema = z.strictObject({
  agents: z.array(AgentSchema),
});
export type AgentsResponse = z.infer<typeof AgentsResponseSchema>;
export const AgentListQuerySchema = z.object({
  namespace: NamespaceSchema.optional(),
});

export const DeviceCodeRequestSchema = z.strictObject({
  machine_label: z.string().min(1).max(LIMITS.maxLabelChars).optional(),
});
export const DeviceCodeResponseSchema = z.strictObject({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  user_code: z
    .string()
    .refine((s) => s.length === 9 && isUserCode(s), "invalid user code"),
  verification_uri: z.string().url(),
  expires_in: z.literal(LIMITS.deviceCodeTtlSec),
  interval: z.literal(LIMITS.devicePollIntervalSec),
});
export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

export const DeviceTokenRequestSchema = z.strictObject({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
});
export const DeviceTokenResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("approved"),
    token: z.string().regex(/^ob_machine_[1-9A-HJ-NP-Za-km-z]{32}$/),
    machine_id: IdSchema,
  }),
  z.strictObject({ status: z.literal("denied") }),
  z.strictObject({ status: z.literal("expired") }),
]);
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;

export const ApprovalBodySchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  label: z.string().min(1).max(LIMITS.maxLabelChars).optional(),
});

/**
 * SSE: each frame is `data: <JSON>\n\n` with no `event:` line; `type` lives
 * inside the JSON so unknown types still reach `onmessage`. On connect the
 * order is `hello`, a full `machines` snapshot, then a full `agents` snapshot.
 * Every later `machines`/`agents` frame is a full list, never a delta.
 * No ping: the Worker holds no timers.
 */
export const BusEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("hello") }),
  z.strictObject({
    type: z.literal("machines"),
    machines: z.array(MachineSchema),
  }),
  z.strictObject({ type: z.literal("agents"), agents: z.array(AgentSchema) }),
]);
export type BusEvent = z.infer<typeof BusEventSchema>;

export const newMachineLabel = (hostname: string): string =>
  hostname.trim().slice(0, LIMITS.maxLabelChars) ||
  `machine-${newId().slice(0, 6)}`;

export const isMachineId = isId;
