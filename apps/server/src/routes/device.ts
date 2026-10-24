import {
  DeviceCodeRequestSchema,
  type DeviceCodeResponse,
  DeviceTokenRequestSchema,
  type DeviceTokenResponse,
  LIMITS,
  newMachineLabel,
  R,
} from "@ob/shared";
import { deriveKey } from "../auth/keys.js";
import { jsonBody } from "../http/body.js";
import { ApiError, appOrigin } from "../http/errors.js";
import { clientIp, clientKey, enforceRateLimit } from "../http/rate-limit.js";
import { hub } from "../hub/stub.js";
import { hmacSign } from "../util/crypto.js";
import type { AppType } from "./types.js";

const NO_STORE = { "cache-control": "no-store" };

/**
 * The CLI's half of the device flow (B4), both `{public}` rows. Each is
 * limited per IP by RL_DEVICE (B11's pattern: fail-open when unbound or
 * failing); behind it the hub caps outstanding codes (MAX_DEVICE_CODES, and
 * DEVICE_CODES_PER_IP per client IP) and answers slow_down per row. Contract (CONTRACT.md): pending | approved |
 * denied | expired; slow_down is 429 `rate_limited` with retryAfterSec; the
 * machine limit is 409 `conflict`.
 */
/**
 * The per-IP share's key (adv-B4 M1): HMAC-SHA256 of the client IP under
 * ob:device-ip, base64url. The hub stores only this, never the IP.
 */
export async function deviceIpTag(
  env: Parameters<typeof deriveKey>[0],
  ip: string,
): Promise<string> {
  return hmacSign(await deriveKey(env, "ob:device-ip"), ip);
}

export function mountDevice(app: AppType): void {
  app.post(R.deviceCode, async (c) => {
    const ip = clientKey(clientIp(c.req.raw));
    await enforceRateLimit(c.env.RL_DEVICE, "device_code", ip);
    const body = await jsonBody(c.req.raw, DeviceCodeRequestSchema);
    const made = await hub(c.env).createDeviceCode(
      newMachineLabel(body.machine_label ?? "machine"),
      await deviceIpTag(c.env, ip),
    );
    if (!made.ok)
      throw new ApiError("rate_limited", "Too many pending device codes", {
        retryAfterSec: 60,
      });
    const res: DeviceCodeResponse = {
      device_code: made.deviceCode,
      user_code: made.userCode,
      verification_uri: `${appOrigin(c.env)}${R.approve(made.userCode)}`,
      expires_in: LIMITS.deviceCodeTtlSec,
      interval: LIMITS.devicePollIntervalSec,
    };
    return c.json(res, 201, NO_STORE);
  });

  app.post(R.deviceToken, async (c) => {
    await enforceRateLimit(
      c.env.RL_DEVICE,
      "device_token",
      clientKey(clientIp(c.req.raw)),
    );
    const { device_code } = await jsonBody(c.req.raw, DeviceTokenRequestSchema);
    const r = await hub(c.env).pollDevice(device_code);
    let res: DeviceTokenResponse;
    switch (r.status) {
      case "slow_down":
        throw new ApiError("rate_limited", "Polling too fast; slow down", {
          retryAfterSec: LIMITS.devicePollIntervalSec,
        });
      case "machine_limit":
        throw new ApiError(
          "conflict",
          "Machine limit reached; revoke a machine, then try again",
        );
      case "approved":
        res = { status: "approved", token: r.token, machine_id: r.machineId };
        break;
      default:
        res = { status: r.status };
    }
    return c.json(res, 200, NO_STORE);
  });
}
