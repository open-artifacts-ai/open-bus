import { ApiError } from "./errors.js";

/** Largest JSON body the device routes read. */
export const MAX_JSON_BYTES = 2048;

type Schema<T> = {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
};

/** Reads at most `max` bytes as UTF-8; null past the cap (streamed, never buffered beyond it). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const buf = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new ApiError("bad_request", "Body is not UTF-8");
  }
}

/**
 * A JSON body checked against a strict schema: 413 `too_large` past `max`
 * bytes, 400 `bad_request` when it does not parse or match. The schema's
 * own messages are not echoed.
 */
export async function jsonBody<T>(
  req: Request,
  schema: Schema<T>,
  max: number = MAX_JSON_BYTES,
): Promise<T> {
  const text = await readCapped(req, max);
  if (text === null) throw new ApiError("too_large", "Body too large");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "Body is not JSON");
  }
  const r = schema.safeParse(v);
  if (!r.success) throw new ApiError("bad_request", "Invalid body");
  return r.data;
}
