import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  AgentsResponseSchema,
  AUTH,
  BusEventSchema,
  CSRF_HEADER,
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  MachineSchema,
  MachinesResponseSchema,
  MeSchema,
  R,
} from "./rest.js";

const ISO = "2026-10-21T15:32:52.652Z";
const machine = {
  id: "7Yb3kQmZ1xRt9PvA",
  label: "MacBook",
  createdAt: ISO,
  lastUsed: ISO,
  revokedAt: null,
  connected: false,
};
const agent = {
  id: "8Zc4mRnA2ySu9QwB",
  namespace: "github.com/a/b",
  name: "OpenBus Backend",
  kind: "opencode",
  machineId: machine.id,
  machineLabel: machine.label,
  global: false,
  state: "live",
  updatedAt: ISO,
};

describe("rest", () => {
  it("pins the routes", () => {
    expect(R.healthz).toBe("/healthz");
    expect(R.deviceCode).toBe("/device/code");
    expect(R.deviceToken).toBe("/device/token");
    expect(R.approve("AB2C-D3E4")).toBe("/approve/AB2C-D3E4");
    expect(R.me).toBe("/api/v1/me");
    expect(R.machines).toBe("/api/v1/machines");
    expect(R.machine(machine.id)).toBe(`/api/v1/machines/${machine.id}`);
    expect(R.agents).toBe("/api/v1/agents");
    expect(R.events).toBe("/api/v1/events");
    expect(R.hub).toBe("/hub");
    expect(R.login).toBe("/auth/login");
    expect(AUTH.login).toBe("/auth/login");
    expect(AUTH.logout).toBe("/auth/logout");
    expect(AUTH.devLogin).toBe("/auth/dev-login");
    expect(CSRF_HEADER).toBe("X-OB-Request");
  });
  it("machine.connected is required and never true when revoked", () => {
    const { connected: _c, ...noFlag } = machine as Record<string, unknown>;
    expect(MachineSchema.safeParse(noFlag).success).toBe(false);
    expect(
      MachineSchema.safeParse({ ...machine, connected: true, revokedAt: null })
        .success,
    ).toBe(true);
    expect(
      MachineSchema.safeParse({
        ...machine,
        connected: true,
        revokedAt: "2026-10-20T12:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      MachineSchema.safeParse({
        ...machine,
        connected: false,
        revokedAt: "2026-10-20T12:00:00.000Z",
      }).success,
    ).toBe(true);
  });
  it("validates DTOs with ISO timestamps", () => {
    expect(
      MeSchema.parse({
        user: { id: "owner", email: "o@example.com", name: null },
      }),
    ).toBeTruthy();
    expect(MachineSchema.parse(machine)).toBeTruthy();
    expect(MachinesResponseSchema.parse({ machines: [machine] })).toBeTruthy();
    expect(AgentSchema.parse(agent)).toBeTruthy();
    expect(AgentsResponseSchema.parse({ agents: [agent] })).toBeTruthy();
    expect(MachineSchema.safeParse({ ...machine, createdAt: 1 }).success).toBe(
      false,
    );
    expect(MachineSchema.safeParse({ ...machine, state: "live" }).success).toBe(
      false,
    );
  });
  it("pins the device flow shapes", () => {
    const code = {
      device_code: "d".repeat(43),
      user_code: "AB2C-D3E4",
      verification_uri: "https://bus.example.com/approve/AB2C-D3E4",
      expires_in: 600,
      interval: 5,
    };
    expect(DeviceCodeResponseSchema.parse(code)).toBeTruthy();
    expect(DeviceTokenResponseSchema.parse({ status: "pending" })).toEqual({
      status: "pending",
    });
    expect(
      DeviceTokenResponseSchema.parse({
        status: "approved",
        token: `ob_machine_${"a".repeat(32)}`,
        machine_id: machine.id,
      }),
    ).toBeTruthy();
    expect(DeviceTokenResponseSchema.parse({ status: "denied" })).toEqual({
      status: "denied",
    });
    expect(
      DeviceTokenResponseSchema.safeParse({ status: "approved" }).success,
    ).toBe(false);
  });
  it("pins the WebSocket feed events as full snapshots", () => {
    expect(BusEventSchema.parse({ type: "hello" })).toEqual({ type: "hello" });
    expect(
      BusEventSchema.parse({ type: "agents", agents: [agent] }),
    ).toBeTruthy();
    expect(
      BusEventSchema.parse({ type: "machines", machines: [machine] }),
    ).toBeTruthy();
    expect(
      BusEventSchema.safeParse({ type: "roster", agents: [] }).success,
    ).toBe(false);
    expect(BusEventSchema.safeParse({ type: "ping" }).success).toBe(false);
  });
  it("allows revoked machines and checks user codes via ids.ts", () => {
    expect(MachineSchema.parse({ ...machine, revokedAt: ISO }).revokedAt).toBe(
      ISO,
    );
    const code = {
      device_code: "d".repeat(43),
      user_code: "AB2C-D3E4",
      verification_uri: "https://bus.example.com/approve/AB2C-D3E4",
      expires_in: 600,
      interval: 5,
    };
    expect(DeviceCodeResponseSchema.safeParse(code).success).toBe(true);
    expect(
      DeviceCodeResponseSchema.safeParse({ ...code, user_code: "IOIO-IOIO" })
        .success,
    ).toBe(false);
    expect(
      DeviceCodeResponseSchema.safeParse({ ...code, user_code: "AB2CD3E4" })
        .success,
    ).toBe(false);
  });
});
