import type { z } from "zod";

/** Server error codes we show copy for; anything else falls back to the message. */
export type ClientErrorCode =
  | "unauthorized"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "internal"
  | "network";

export class ApiClientError extends Error {
  code: ClientErrorCode;
  status: number;
  constructor(code: ClientErrorCode, message: string, status: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
  }
}

/** Cookie-authenticated mutations need this header (Backend's csrf()). */
export const CSRF_HEADER = "X-OB-Request";

const KNOWN: readonly string[] = [
  "unauthorized",
  "not_found",
  "bad_request",
  "rate_limited",
  "internal",
];

/** Accepts `{error:{code,message}}` (OA's shape) or `{code,message}`. */
function toError(text: string, status: number): ApiClientError {
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {}
  const box = (raw as { error?: unknown })?.error ?? raw;
  const code = (box as { code?: unknown })?.code;
  const message = (box as { message?: unknown })?.message;
  let out: ClientErrorCode = "internal";
  if (typeof code === "string" && KNOWN.includes(code))
    out = code as ClientErrorCode;
  else if (status === 401) out = "unauthorized";
  return new ApiClientError(
    out,
    typeof message === "string" && message
      ? message
      : `Unexpected response (HTTP ${status})`,
    status,
  );
}

async function request(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new ApiClientError("network", "Couldn't reach the bus.", 0);
  }
  if (res.ok) return res;
  throw toError(await res.text().catch(() => ""), res.status);
}

async function parse<T>(
  res: Response,
  schema: z.ZodType<T> | undefined,
): Promise<T> {
  if (!schema || res.status === 204) return undefined as T;
  const out = schema.safeParse(await res.json().catch(() => null));
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
    const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
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
