import { z } from "zod";
import { LIMITS } from "./limits.js";
import { FALLBACK_BUS_NAME } from "./meta.js";

/**
 * A bus name: 1..64 chars, letters/digits/space/._-, starting with a letter or
 * digit, not ending in space or dot. No `@`, `/`, `\`, `:` or control chars, so
 * a name can never look like an address or a URL (spec: "Address-shaped names
 * are rejected").
 */
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/;

export const BusNameSchema = z
  .string()
  .max(LIMITS.maxBusNameChars)
  .refine(
    (s) => NAME_RE.test(s) && s !== "." && s !== "..",
    "invalid bus name",
  );
export type BusName = z.infer<typeof BusNameSchema>;

/** "Base-2": trims the base so the suffix fits inside maxBusNameChars. */
export function suffixName(base: string, n: number): string {
  const suffix = `-${n}`;
  const room = LIMITS.maxBusNameChars - suffix.length;
  const stem = base.slice(0, room).replace(/[ .]+$/, "");
  return `${stem || FALLBACK_BUS_NAME}${suffix}`;
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
