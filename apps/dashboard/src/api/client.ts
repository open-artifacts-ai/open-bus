import type { z } from "zod";
import {
  CSRF_HEADER,
  CSRF_VALUE,
  ERROR_CODES,
  type ErrorCode,
} from "./contract";

/** Server error codes we show copy for (the contract's list) plus client-side `network`. */
export type ClientErrorCode = ErrorCode | "network";

export class ApiClientError extends Error {
  code: ClientErrorCode;
  status: number;
  /** From the envelope's `details.retryAfterSec` (rate limits), when valid. */
  retryAfterSec: number | undefined;
  /** From `details.field` (a 400's offending field, e.g. `agentId`), when a string. */
  field: string | undefined;
  constructor(
    code: ClientErrorCode,
    message: string,
    status: number,
    retryAfterSec?: number,
    field?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.field = field;
  }
}

const KNOWN: readonly string[] = ERROR_CODES;

const BY_STATUS: Record<number, ClientErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  429: "rate_limited",
};

/**
 * The shared envelope `{error:{code,message,details?}}`. A body that isn't
 * one (a proxy's HTML page, an empty 502) falls back to the HTTP status.
 */
function toError(text: string, status: number): ApiClientError {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {}
  const box = (raw as { error?: unknown } | null)?.error;
  const code = (box as { code?: unknown })?.code;
  const message = (box as { message?: unknown })?.message;
  const details = (
    box as { details?: { retryAfterSec?: unknown; field?: unknown } }
  )?.details;
  const retry = details?.retryAfterSec;
  let out: ClientErrorCode;
  // A 401 is a lost session whatever the body says: it must sign the owner out.
  if (status === 401) out = "unauthorized";
  else if (typeof code === "string" && KNOWN.includes(code))
    out = code as ClientErrorCode;
  else out = BY_STATUS[status] ?? "internal";
  return new ApiClientError(
    out,
    typeof message === "string" && message
      ? message
      : `Unexpected response (HTTP ${status})`,
    status,
    Number.isInteger(retry) && (retry as number) >= 0
      ? (retry as number)
      : undefined,
    typeof details?.field === "string" ? details.field : undefined,
  );
}

/** Body-read failures become a fallback value, except cancellation, which must propagate. */
const swallowUnlessAbort =
  <T>(fallback: T) =>
  (e: unknown): T => {
    if (e instanceof Error && e.name === "AbortError") throw e;
    return fallback;
  };

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiClientError("network", "Couldn't reach the bus.", 0);
  }
  if (res.ok) return res;
  throw toError(await res.text().catch(swallowUnlessAbort("")), res.status);
}

async function parse<T>(
  res: Response,
  schema: z.ZodType<T> | undefined,
): Promise<T> {
  if (!schema || res.status === 204) return undefined as T;
  const out = schema.safeParse(
    await res.json().catch(swallowUnlessAbort(null)),
  );
  if (out.success) return out.data;
  const fields = [
    ...new Set(out.error.issues.map((i) => i.path.join(".") || "(root)")),
  ];
  throw new ApiClientError(
    "internal",
    `Invalid response: ${fields.join(", ")}`,
    res.status,
  );
}

export const api = {
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return parse(await request(path, { method: "GET", signal }), schema);
  },
  async send<T = void>(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    schema?: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = { [CSRF_HEADER]: CSRF_VALUE };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return parse(res, schema);
  },
};
