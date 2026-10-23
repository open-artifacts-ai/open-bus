// base58 (Bitcoin alphabet, no 0 O I l), unbiased rejection sampling.
// Copied from openartifacts/packages/shared/src/ids.ts; PAT prefix -> machine token.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_UNBIASED = 256 - (256 % 58);

function randomBase58(n: number): string {
  let out = "";
  const buf = new Uint8Array(Math.max(n * 2, 16));
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < n; i++) {
      const b = buf[i] as number;
      if (b < MAX_UNBIASED) out += ALPHABET[b % 58];
    }
  }
  return out;
}

const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{16}$/;
const MACHINE_TOKEN_RE = /^ob_machine_[1-9A-HJ-NP-Za-km-z]{32}$/;
/** The user-code alphabet: 32 symbols, no 0/1, so O/0 and I/1 cannot be mistyped. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export function newId(): string {
  return randomBase58(16);
}
export function isId(s: string): boolean {
  return ID_RE.test(s);
}
export const newMsgId = newId;

export function newMachineToken(): string {
  return `ob_machine_${randomBase58(32)}`;
}
export function isMachineToken(s: string): boolean {
  return MACHINE_TOKEN_RE.test(s);
}

/** The device flow's secret half (`device_code`): 43 base58 chars, never shown to a human. */
const DEVICE_SECRET_RE = /^[1-9A-HJ-NP-Za-km-z]{43}$/;
export function newDeviceSecret(): string {
  return randomBase58(43);
}
export function isDeviceSecret(s: string): boolean {
  return DEVICE_SECRET_RE.test(s);
}

/** 8 unformatted chars, e.g. "AB2CD3E4". */
export function newUserCode(): string {
  let out = "";
  const buf = new Uint8Array(16);
  while (out.length < 8) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && out.length < 8; i++) {
      const b = buf[i] as number;
      if (b < 256 - (256 % 32)) out += USER_CODE_ALPHABET[b % 32];
    }
  }
  return out;
}
/** "AB2CD3E4" -> "AB2C-D3E4". */
export function formatUserCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
export function isUserCode(s: string): boolean {
  return USER_CODE_RE.test(s);
}
/** Accepts "ab2c-d3e4", "AB2C D3E4", "ab2cd3e4"; null when it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const raw = input.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z2-9]{8}$/.test(raw) ? raw : null;
}
