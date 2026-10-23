import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMachineToken, LIMITS } from "@ob/shared";
import { z } from "zod";
import type { Deps } from "../deps.ts";

// TODO(F2.4): import from @ob/shared once packages/shared/src/rest.ts lands.
const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
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

const post = (args: LoginArgs, path: string, body: unknown) =>
  args.fetch(`${args.hub}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export async function login(args: LoginArgs): Promise<LoginResult> {
  const print = args.print ?? (() => {});
  const codeRes = await post(args, "/device/code", {
    machine_label: args.label,
  });
  if (!codeRes.ok)
    throw new Error(
      `device/code failed: ${codeRes.status} ${await codeRes.text()}`,
    );
  const device = DeviceCodeResponseSchema.parse(await codeRes.json());

  const url = device.verification_uri;
  const opened = args.noOpen ? false : await args.openBrowser(url);
  if (!opened)
    print(`Open ${url} and approve this machine. Code: ${device.user_code}`);

  const deadline = args.now() + device.expires_in * 1000;
  const intervalSec = Math.max(
    device.interval || LIMITS.devicePollIntervalSec,
    1,
  );
  while (args.now() < deadline) {
    await args.sleep(intervalSec * 1000);
    const res = await post(args, "/device/token", {
      device_code: device.device_code,
    });
    if (!res.ok)
      throw new Error(`device/token failed: ${res.status} ${await res.text()}`);
    const poll = DeviceTokenResponseSchema.parse(await res.json());
    switch (poll.status) {
      case "pending":
        continue;
      case "denied":
        throw new Error("login denied: the approval was rejected");
      case "expired":
        throw new Error("device code expired; run `open-bus login` again");
      case "approved": {
        mkdirSync(args.home, { recursive: true, mode: 0o700 });
        const file = join(args.home, "machine.json");
        writeFileSync(
          file,
          `${JSON.stringify(
            {
              hub: args.hub,
              machine_id: poll.machine_id,
              label: args.label,
              machine_token: poll.token,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        chmodSync(file, 0o600);
        print(`Approved this machine as ${args.label}.`);
        return {
          machineToken: poll.token,
          machineId: poll.machine_id,
          label: args.label,
          hub: args.hub,
          home: args.home,
        };
      }
    }
  }
  throw new Error("device approval timed out; run `open-bus login` again");
}
