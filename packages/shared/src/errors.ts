import { z } from "zod";

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

/** Structured, non-leaking extras only: no free-form payloads (stack traces, internals). */
export const ApiErrorDetailsSchema = z.strictObject({
  field: z.string().max(128).optional(),
  retryAfterSec: z.number().int().nonnegative().optional(),
});
export type ApiErrorDetails = z.infer<typeof ApiErrorDetailsSchema>;

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: ApiErrorDetailsSchema.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const STATUS_FOR: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  rate_limited: 429,
  internal: 500,
};
