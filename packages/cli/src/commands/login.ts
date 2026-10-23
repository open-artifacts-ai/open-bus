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
import {
  DeviceCodeRequestSchema,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  newMachineLabel,
  R,
} from "@ob/shared";
import { type Deps, realDeps } from "../deps.ts";

type LoginArgs = {
  hub: string;
  home: string;
  /** Sent as machine_label and stored as the machine's label; defaults to the hostname. */
  label?: string;
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

const POLL_MAX_BACKOFF_MS = 30_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const normalizeHub = (hub: string) => hub.replace(/\/+$/, "");

/**
 * https (http only for loopback), the hub's own origin, no userinfo and exactly
 * /approve/<user_code>; anything else is never opened or shown. The shared
 * schema checks most of this too; the origin only the client can know.
 */
function checkVerificationUri(
  uri: string,
  hub: string,
  userCode: string,
): string {
  const u = new URL(uri);
  const secure =
    u.protocol === "https:" ||
    (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (
    !secure ||
    u.origin !== new URL(hub).origin ||
    u.username ||
    u.password ||
    u.pathname !== `/approve/${userCode}` ||
    u.search ||
    u.hash
  ) {
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
  const label = newMachineLabel(args.label ?? hostname());
  const codeRes = await post(
    hub,
    args.fetch,
    R.deviceCode,
    DeviceCodeRequestSchema.parse({ machine_label: label }),
  );
  if (!codeRes.ok) {
    throw new Error(
      `device/code failed: ${codeRes.status} ${(await codeRes.text()).slice(0, 200)}`,
    );
  }
  const device = DeviceCodeResponseSchema.parse(await codeRes.json());
  const url = checkVerificationUri(
    device.verification_uri,
    hub,
    device.user_code,
  );

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
      res = await post(
        hub,
        args.fetch,
        R.deviceToken,
        DeviceTokenRequestSchema.parse({ device_code: device.device_code }),
      );
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
