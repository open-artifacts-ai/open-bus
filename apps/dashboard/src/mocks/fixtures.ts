import { AgentSchema, MachineSchema, MeSchema } from "../api/contract";

// Parsed at import, so drift from the contract fails loudly (ids are 16-char base58).
const machine = (m: unknown) => MachineSchema.parse(m);
const agent = (a: unknown) => AgentSchema.parse(a);

const T = "2026-10-21T10:00:00.000Z";
const STUDIO = "StudioMbp7Xk2aQz";
const THINKPAD = "Thinkpad9Wb4Rnxy";
const TRAVEL = "TravAir3Kp5VmqXy";

export const fixtures = {
  machines: [
    machine({
      id: STUDIO,
      label: "studio-mbp",
      createdAt: T,
      lastUsed: "2026-10-21T09:58:00.000Z",
      revokedAt: null,
      connected: true,
    }),
    machine({
      id: THINKPAD,
      label: "old-thinkpad",
      createdAt: "2026-10-19T08:00:00.000Z",
      lastUsed: null,
      revokedAt: "2026-10-20T12:00:00.000Z",
      connected: false,
    }),
    // Approved but offline: its open session shows as queued.
    machine({
      id: TRAVEL,
      label: "travel-air",
      createdAt: "2026-10-20T08:00:00.000Z",
      lastUsed: "2026-10-20T18:30:00.000Z",
      revokedAt: null,
      connected: false,
    }),
  ],
  agents: [
    agent({
      id: "AgentCode1Aaaaaa",
      namespace: "github.com/acme/app",
      name: "claude-1",
      kind: "claude-code",
      machineId: STUDIO,
      machineLabel: "studio-mbp",
      global: false,
      state: "live",
      updatedAt: T,
    }),
    agent({
      id: "AgentCodeTwo1Bbb",
      namespace: "github.com/acme/app",
      name: "opencode-1",
      kind: "opencode",
      machineId: TRAVEL,
      machineLabel: "travel-air",
      global: false,
      state: "queued",
      updatedAt: T,
    }),
    agent({
      id: "AgentScoutPi1Ccc",
      namespace: "github.com/acme/docs",
      name: "scout",
      kind: "pi",
      machineId: STUDIO,
      machineLabel: "studio-mbp",
      global: true,
      state: "live",
      updatedAt: T,
    }),
  ],
  me: MeSchema.parse({
    user: { id: "owner", email: "ada@example.com", name: null },
  }),
};
