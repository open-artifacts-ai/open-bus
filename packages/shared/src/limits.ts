const KB = 1024;

/** Every pinned value from the spec and the plan overview. Do not tune per instance. */
export const LIMITS = {
  /** A body at or below this arrives inline in `deliver`; above it, a notice + fetch. */
  inlineBodyBytes: 32 * KB,
  /** Hard cap on one message body (below SQLite's 2 MB row limit). */
  maxMessageBytes: 1024 * KB,
  /** Undelivered mail expires this long after it was sent. */
  mailTtlSec: 3600,
  /** Undelivered messages per agent, then `refused: inbox_full`. */
  inboxCap: 50,
  /** The hub stops holding a pushed-but-unacked message after this. */
  ackTimeoutMs: 10_000,
  deviceCodeTtlSec: 600,
  devicePollIntervalSec: 5,
  /** WebSocket close code on revoke (and on any socket the hub invalidates). */
  revokeCloseCode: 4403,
  /** WebSocket close code for a protocol violation. */
  protocolCloseCode: 1008,
  /** One live daemon socket per machine: a reconnect replaces the previous one. */
  maxSocketsPerMachine: 1,
  /** Bare-string keepalive: the daemon sends PING, the hub auto-answers PONG. */
  pingIntervalMs: 25_000,
  maxBusNameChars: 64,
  maxNamespaceChars: 128,
  maxAgentRefChars: 128,
  maxLabelChars: 64,
} as const;

export const PING = "ping";
export const PONG = "pong";

const enc = new TextEncoder();
export const utf8Bytes = (s: string): number => enc.encode(s).length;
/** True when `s` exceeds `max` UTF-8 bytes. UTF-8 bytes >= UTF-16 units, so a longer string short-circuits. */
export const utf8Exceeds = (s: string, max: number): boolean =>
  s.length > max || utf8Bytes(s) > max;
