/**
 * The dashboard's view of the REST/SSE contract: re-exports from @ob/shared
 * (F2.4). The single place the FE names the shared schemas, so a rename
 * upstream is one edit here. Never add local schema copies.
 */
export {
  type Agent,
  AgentSchema,
  AgentsResponseSchema,
  ApiErrorSchema,
  AUTH,
  type BusEvent,
  BusEventSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  ERROR_CODES,
  type ErrorCode,
  type Machine,
  MachineSchema,
  MachinesResponseSchema,
  type Me,
  MeSchema,
  R,
  WireNamespaceSchema,
} from "@ob/shared";
