/**
 * `@ob/shared/rest`: the REST/SSE contract only, for the dashboard bundle (and
 * the Worker's HTTP layer). Re-exports from `rest.ts`, `errors.ts` and the
 * small modules those depend on. It must never import `protocol.ts` or
 * `receipts.ts` (the WebSocket frames), or a browser bundle would ship them;
 * `rest-entry.test.ts` bundles it with esbuild to prove that.
 */
export {
  ApiErrorSchema,
  ERROR_CODES,
  type ErrorCode,
  STATUS_FOR,
} from "./errors.js";
export { IdSchema, isId, isMachineToken } from "./ids.js";
export { type AgentKind, AgentKindSchema } from "./kinds.js";
export { LIMITS } from "./limits.js";
export { BusNameSchema } from "./names.js";
export { WireNamespaceSchema } from "./namespace.js";
export { MachineLabelSchema } from "./refs.js";
export {
  type Agent,
  AgentListQuerySchema,
  AgentSchema,
  type AgentsResponse,
  AgentsResponseSchema,
  AUTH,
  type BusEvent,
  BusEventSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  type Machine,
  MachineSchema,
  type MachinesResponse,
  MachinesResponseSchema,
  type Me,
  MeSchema,
  R,
} from "./rest.js";
