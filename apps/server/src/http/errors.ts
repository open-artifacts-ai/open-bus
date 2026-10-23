import { type ErrorCode, STATUS_FOR } from "@ob/shared";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../env.js";

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorJson(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
  headers?: HeadersInit,
): Response {
  const error: { code: ErrorCode; message: string; details?: unknown } = {
    code,
    message,
  };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status, headers });
}

/**
 * HTTPException status -> the @ob/shared code with that status. 403 is left
 * out: its only code is `csrf`, which would mislabel any other refusal.
 * Unmapped statuses answer 500 `internal`, so status and code always agree.
 */
const CODE_FOR_HTTP: Partial<Record<number, ErrorCode>> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
  413: "too_large",
  429: "rate_limited",
};

export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    return errorJson(STATUS_FOR[e.code] ?? 500, e.code, e.message, e.details);
  }
  if (e instanceof HTTPException) {
    const code = CODE_FOR_HTTP[e.status];
    if (code) return errorJson(STATUS_FOR[code], code, e.message);
  }
  // Name only, never the value: error text can carry URLs or tokens.
  console.error(
    JSON.stringify({
      event: "unhandled_error",
      name: e instanceof Error ? e.name : typeof e,
    }),
  );
  return errorJson(STATUS_FOR.internal, "internal", "Internal error");
}

/** The app's own origin. Always https: staging and production are custom domains. */
export function appOrigin(env: Pick<Env, "APP_HOST">): string {
  return `https://${env.APP_HOST}`;
}
