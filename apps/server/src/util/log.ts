/**
 * Structured, secret-free logs: one JSON line per event. Never tokens, codes,
 * bodies, emails or secrets: callers pass only ids, error codes, kinds and
 * counts, and every string is scrubbed here as a backstop (token-shaped
 * values are replaced) and capped at MAX_CHARS.
 */
type Field = string | number | boolean | null;

const MAX_CHARS = 200;
const REDACTED = "[redacted]";

/**
 * Token-shaped substrings: JWTs, machine tokens, bearer credentials, long
 * base58, base64url or hex runs (device secrets, OIDC codes, token hashes),
 * user codes, email addresses and IP addresses. Ids (16 base58 chars),
 * event names and error codes pass.
 */
const SECRET_SHAPES: RegExp[] = [
  // JWTs: three dot-separated base64url segments (B11 L2).
  /[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /ob_machine_[1-9A-HJ-NP-Za-km-z]*/g,
  /bearer\s+\S+/gi,
  // base64url runs of 20+ (OIDC codes, states, nonces), unless all
  // lowercase letters and underscores (event names and kinds).
  /(?=[A-Za-z0-9_-]*[A-Z0-9-])[A-Za-z0-9_-]{20,}/g,
  // IPv4 and IPv6 addresses (rate-limit keys are `<kind>:<ip>`).
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi,
  /[1-9A-HJ-NP-Za-km-z]{32,}/g,
  /[0-9a-f]{32,}/gi,
  /\b[A-Z2-9]{4}-?[A-Z2-9]{4}\b/g,
  /[^\s@"]+@[^\s@"]+/g,
];

function scrub(s: string): string {
  let out = s;
  for (const re of SECRET_SHAPES) out = out.replace(re, REDACTED);
  return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) : out;
}

export function logEvent(
  evt: string,
  fields: Record<string, Field> = {},
): void {
  const line: Record<string, Field> = { evt: scrub(evt) };
  for (const [k, v] of Object.entries(fields))
    line[k] = typeof v === "string" ? scrub(v) : v;
  console.log(JSON.stringify(line));
}

export function logError(evt: string, err: unknown): void {
  const message = err instanceof Error ? scrub(err.message) : "unknown";
  console.error(JSON.stringify({ evt: scrub(evt), message }));
}
