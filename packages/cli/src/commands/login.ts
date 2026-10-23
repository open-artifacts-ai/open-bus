import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isMachineToken, LIMITS } from "@ob/shared";
import { z } from "zod";
import { type Deps, realDeps } from "../deps.ts";

// TODO(F2.4): import from @ob/shared once packages/shared/src/rest.ts lands.
const DeviceCodeResponseSchema = z.object({
  device_code: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  user_code: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
  verification_uri: z.url(),
  expires_in: z.literal(LIMITS.deviceCodeTtlSec),
  interval: z.literal(LIMITS.devicePollIntervalSec),
});
const DeviceTokenResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("approved"),
    token: z.string().refine(isMachineToken, "malformed machine token"),
    machine_id: z.string().min(1),
  }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
]);

type LoginArgs = {
  hub: string;
  home: string;
  /** Sent as machine_label and stored as the machine's label. */
  label: string;
  noOpen?: boolean;
} & Pick<Deps, "fetch" | "openBrowser" | "sleep" | "now"> &
  Partial<Pick<Deps, "print">>;

export type LoginResult = {
  machineToken: string;
  machineId: string;
  label: string;
  hub: string;
  home: string;
};

// Controls, bidi marks/isolates, zero-width and separator chars, BOM, lone surrogates.
const UNSAFE =
  /[\p{Cc}\p{Cs}\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
const MAX_LABEL = 128;

/** Backend contract: machine_label <= 128 UTF-16 units, no control or bidi characters. */
export const sanitizeLabel = (raw: string): string => {
  let out = "";
  for (const ch of raw.replace(UNSAFE, "").trim()) {
    if (out.length + ch.length > MAX_LABEL) break;
    out += ch;
  }
  return out.trim() || "machine";
};

/** Default machine label: the sanitized hostname. */
export const machineLabel = (host: () => string = hostname): string =>
  sanitizeLabel(host());

const POLL_MAX_BACKOFF_MS = 30_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const normalizeHub = (hub: string) => hub.replace(/\/+$/, "");

/** https (http only for loopback) and the hub's own origin; anything else is never opened or shown. */
function checkVerificationUri(uri: string, hub: string): string {
  const u = new URL(uri);
  const secure =
    u.protocol === "https:" ||
    (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!secure || u.origin !== new URL(hub).origin) {
    throw new Error(
      "device/code returned a verification_uri that is not on the hub origin",
    );
  }
  return u.href;
}

function writeMachineFile(home: string, body: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const tmp = join(home, `.machine.json.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    // rename replaces a symlink at machine.json rather than following it.
    renameSync(tmp, join(home, "machine.json"));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}

const post = (hub: string, fetch: Deps["fetch"], path: string, body: unknown) =>
  fetch(`${hub}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export async function login(args: LoginArgs): Promise<LoginResult> {
  const print = args.print ?? realDeps.print;
  const hub = normalizeHub(args.hub);
  const label = sanitizeLabel(args.label);
  const codeRes = await post(hub, args.fetch, "/device/code", {
    machine_label: label,
  });
  if (!codeRes.ok) {
    throw new Error(
      `device/code failed: ${codeRes.status} ${(await codeRes.text()).slice(0, 200)}`,
    );
  }
  const device = DeviceCodeResponseSchema.parse(await codeRes.json());
  const url = checkVerificationUri(device.verification_uri, hub);

  print(`Open ${url} and approve this machine. Code: ${device.user_code}`);
  if (!args.noOpen) await args.openBrowser(url);

  const deadline = args.now() + device.expires_in * 1000;
  const baseMs = device.interval * 1000;
  // Bounds the loop even if the clock misbehaves.
  const maxPolls = Math.ceil(device.expires_in / device.interval) * 2;
  let waitMs = baseMs;
  for (let n = 0; n < maxPolls && args.now() < deadline; n++) {
    await args.sleep(waitMs);
    let res: Response;
    try {
      res = await post(hub, args.fetch, "/device/token", {
        device_code: device.device_code,
      });
    } catch {
      continue; // transient network error
    }
    if (res.status === 429) {
      waitMs = Math.min(waitMs * 2, POLL_MAX_BACKOFF_MS);
      continue;
    }
    if (res.status >= 500) continue;
    waitMs = baseMs;
    if (!res.ok) {
      throw new Error(
        `device/token failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    }
    const poll = DeviceTokenResponseSchema.parse(await res.json());
    switch (poll.status) {
      case "pending":
        continue;
      case "denied":
        throw new Error("login denied: the approval was rejected");
      case "expired":
        throw new Error("device code expired; run `open-bus login` again");
      case "approved": {
        writeMachineFile(
          args.home,
          `${JSON.stringify({ hub, machine_id: poll.machine_id, label, machine_token: poll.token }, null, 2)}\n`,
        );
        print(`Approved this machine as ${label}.`);
        return {
          machineToken: poll.token,
          machineId: poll.machine_id,
          label,
          hub,
          home: args.home,
        };
      }
    }
  }
  throw new Error("device approval timed out; run `open-bus login` again");
}
