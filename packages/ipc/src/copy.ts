import { LIMITS, type ReceiptReason, type ReceiptState } from "@ob/shared";

/** One terminal line at most; the transcript's "cutting long values" rule. */
const MAX_COLS = 80;
const HOUR = `${LIMITS.mailTtlSec / 3600} hour`;
const MB = `${LIMITS.maxMessageBytes / (1024 * 1024)} MB`;

/** Cuts `value` in the middle, keeping its end, so `line(value)` fits 80 columns. */
function fitLine(line: (value: string) => string, value: string): string {
  const over = line(value).length - MAX_COLS;
  if (over <= 0) return line(value);
  const keep = value.length - over - 1;
  if (keep < 2) return line(value);
  const head = Math.ceil(keep / 2);
  return line(
    `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`,
  );
}

const refusals: Record<string, [(to: string, n?: number) => string, string]> = {
  unknown_agent: [
    (to) => `no agent named ${to} here.`,
    "Run list_agents to see who is in this namespace.",
  ],
  closed: [
    (to) => `${to} did not accept it.`,
    "Send it again once the session is open, or message another agent.",
  ],
  inbox_full: [
    (to) => `${to} has ${LIMITS.inboxCap} messages waiting.`,
    "Send again once some are delivered or expire.",
  ],
  too_large: [() => `the message is over ${MB}.`, "Send a shorter message."],
  other_namespace: [
    (to) => `${to} is in another namespace.`,
    "Message agents in this namespace only.",
  ],
  revoked: [
    (to) => `${to}'s machine was revoked.`,
    "Message another agent, or approve that machine again with npx open-bus login.",
  ],
  ambiguous: [
    (to, n) =>
      `${to} exists in ${n && n > 1 ? `${n} namespaces` : "more than one namespace"}.`,
    "Send again with to_namespace set to one of them.",
  ],
};

/**
 * A receipt as an agent reads it: design/cli/transcript.md "Receipts",
 * verbatim, uncoloured (the glyph carries the state). `namespaces` is how many
 * namespaces hold `to`, for `ambiguous`.
 */
export function receiptText(
  r: { state: ReceiptState; reason?: ReceiptReason },
  to: string,
  namespaces?: number,
): string {
  switch (r.state) {
    case "pending":
      return fitLine(
        (v) => `○  Queued for ${v}. Not delivered yet; expires in ${HOUR}.`,
        to,
      );
    case "delivered":
      return fitLine((v) => `✓  Delivered to ${v}.`, to);
    case "expired":
      return r.reason === "recipient_closed"
        ? fitLine((v) => `×  Expired: ${v} closed before it was delivered.`, to)
        : fitLine(
            (v) => `×  Expired: ${v} did not take it within ${HOUR}.`,
            to,
          );
    case "refused": {
      const copy = r.reason ? refusals[r.reason] : undefined;
      if (!copy)
        return fitLine((v) => `×  Refused: ${v} did not accept it.`, to);
      const [first, hint] = copy;
      return `${fitLine((v) => `×  Refused (${r.reason}): ${first(v, namespaces)}`, to)}\n   ${hint}`;
    }
  }
}
