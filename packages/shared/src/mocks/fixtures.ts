import type { Agent, Machine, Me } from "../rest.js";

const T = "2026-10-21T10:00:00.000Z";

/** Hard-coded 16-char base58 ids (generated once with newId()). */
const STUDIO = "hYRsumPp5XEKui7m";
const LAPTOP = "gBU34nzaAXEesQMc";
const THINKPAD = "sy23f4mYEeyqQD4j";

export const me: Me = {
  user: { id: "owner", email: "ada@example.com", name: null },
};

/** Newest first, like the Worker: two active machines and one revoked. */
export const machines: Machine[] = [
  {
    id: STUDIO,
    label: "studio-mbp",
    createdAt: T,
    lastUsed: "2026-10-21T09:58:00.000Z",
    revokedAt: null,
  },
  {
    id: LAPTOP,
    label: "laptop",
    createdAt: "2026-10-20T08:00:00.000Z",
    lastUsed: null,
    revokedAt: null,
  },
  {
    id: THINKPAD,
    label: "old-thinkpad",
    createdAt: "2026-10-19T08:00:00.000Z",
    lastUsed: "2026-10-19T18:00:00.000Z",
    revokedAt: "2026-10-20T12:00:00.000Z",
  },
];

/** Closed agents are never listed: every agent is `live` or `queued`. */
export const agents: Agent[] = [
  {
    id: "kpbHbMX4JAq8FDqg",
    namespace: "github.com/acme/app",
    name: "claude-1",
    kind: "claude-code",
    machineId: STUDIO,
    machineLabel: "studio-mbp",
    global: false,
    state: "live",
    updatedAt: T,
  },
  {
    id: "uQYqrisiMGYjay54",
    namespace: "github.com/acme/app",
    name: "opencode-1",
    kind: "opencode",
    machineId: LAPTOP,
    machineLabel: "laptop",
    global: false,
    state: "queued",
    updatedAt: T,
  },
  {
    id: "ek2Qsq7Ri2RAFgcx",
    namespace: "github.com/acme/docs",
    name: "scout",
    kind: "pi",
    machineId: STUDIO,
    machineLabel: "studio-mbp",
    global: true,
    state: "live",
    updatedAt: T,
  },
];
