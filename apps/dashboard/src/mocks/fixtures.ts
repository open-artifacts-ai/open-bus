import { AgentSchema, MachineSchema, MeSchema } from "../api/contract";

// Parsed at import, so drift from the contract fails loudly (ids are 16-char base58).
const machine = (m: unknown) => MachineSchema.parse(m);
const agent = (a: unknown) => AgentSchema.parse(a);

const T = "2026-10-21T10:00:00.000Z";
const STUDIO = "StudioMbp7Xk2aQz";
const THINKPAD = "Thinkpad9Wb4Rnxy";

export const fixtures = {
  machines: [
    machine({
      id: STUDIO,
      label: "studio-mbp",
      createdAt: T,
      lastUsed: "2026-10-21T09:58:00.000Z",
      revokedAt: null,
    }),
    machine({
      id: THINKPAD,
      label: "old-thinkpad",
      createdAt: "2026-10-19T08:00:00.000Z",
      lastUsed: null,
      revokedAt: "2026-10-20T12:00:00.000Z",
    }),
  ],
  agents: [
    agent({
      id: "AgentCode1Aaaaaa",
      namespace: "repo:github.com/acme/app",
      name: "claude-1",
      kind: "claude-code",
      machineId: STUDIO,
      machineLabel: "studio-mbp",
      global: false,
      live: true,
      updatedAt: T,
    }),
    agent({
      id: "AgentCodeTwo1Bbb",
      namespace: "repo:github.com/acme/app",
      name: "opencode-1",
      kind: "opencode",
      machineId: STUDIO,
      machineLabel: "studio-mbp",
      global: false,
      live: false,
      updatedAt: T,
    }),
    agent({
      id: "AgentScoutPi1Ccc",
      namespace: "repo:github.com/acme/docs",
      name: "scout",
      kind: "pi",
      machineId: STUDIO,
      machineLabel: "studio-mbp",
      global: true,
      live: true,
      updatedAt: T,
    }),
  ],
  me: MeSchema.parse({
    user: { id: "owner", email: "ada@example.com", name: null },
  }),
};
