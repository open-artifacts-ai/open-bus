import { z } from "zod";
import { LIMITS } from "./limits.js";
import { FALLBACK_BUS_NAME } from "./meta.js";

/**
 * A bus name: 1..64 chars, letters/digits/space/._-, starting with a letter or
 * digit, ending in a letter, digit, `_` or `-` (never space or dot). No `@`,
 * `/`, `\`, `:` or control chars, and no IPv4-shaped names, so a name can
 * never look like an address (spec: "Address-shaped names are rejected").
 * Domain-shaped names such as `example.com` stay valid.
 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-])?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export const BusNameSchema = z
  .string()
  .max(LIMITS.maxBusNameChars)
  .refine((s) => NAME_RE.test(s) && !IPV4_RE.test(s), "invalid bus name");
export type BusName = z.infer<typeof BusNameSchema>;

/**
 * "Base-2": trims the base so the suffix fits inside maxBusNameChars. Throws
 * unless `base` is a valid bus name and `n` a safe integer >= 2, so the result
 * is always a valid bus name.
 */
export function suffixName(base: string, n: number): string {
  if (!BusNameSchema.safeParse(base).success)
    throw new Error("suffixName: base is not a valid bus name");
  if (!Number.isSafeInteger(n) || n < 2)
    throw new Error("suffixName: n must be an integer >= 2");
  const suffix = `-${n}`;
  const room = LIMITS.maxBusNameChars - suffix.length;
  const stem = base.slice(0, room).replace(/[ .]+$/, "");
  return `${stem}${suffix}`;
}

/** A harness proposal made safe: control chars stripped, trimmed, capped. */
export function candidateName(proposed: string): string {
  const cleaned = proposed
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, LIMITS.maxBusNameChars)
    .replace(/[ .]+$/, "");
  return BusNameSchema.safeParse(cleaned).success ? cleaned : FALLBACK_BUS_NAME;
}
