/**
 * Local mirror of @ob/shared (01b F2.4); replace with re-exports when it lands.
 * The single place the FE names F2's REST schemas, so a rename is one edit.
 */
import { z } from "zod";

const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16}$/;
const IdSchema = z.string().refine((s) => ID_RE.test(s), "invalid id");

const LIMITS = {
  maxBusNameChars: 64,
  maxNamespaceChars: 128,
  maxLabelChars: 64,
} as const;

const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/;
const BusNameSchema = z
  .string()
  .max(LIMITS.maxBusNameChars)
  .refine(
    (s) => NAME_RE.test(s) && s !== "." && s !== "..",
    "invalid bus name",
  );

// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are forbidden
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const NamespaceSchema = z
  .string()
  .min(1)
  .max(LIMITS.maxNamespaceChars)
  .refine((s) => s === s.trim() && !CONTROL_CHARS.test(s), "invalid namespace");

export const AGENT_KINDS = ["claude-code", "opencode", "pi"] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "csrf",
  "not_found",
  "conflict",
  "too_large",
  "rate_limited",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
export { ApiErrorSchema as ErrorSchema };

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
 * A machine the owner approved. Only active machines are listed, so
 * `revokedAt` is normally null; `lastUsed` is the last /hub upgrade.
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

/**
 * SSE: `event: <type>` and `data: <JSON>`. Every snapshot is the full list the
 * page should show. `hello` opens the stream and tells the client to refetch.
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
