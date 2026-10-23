import type { DeliverFrame } from "@ob/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentTable } from "../src/agents.ts";
import { createDeliver } from "../src/deliver.ts";

const frame = (msg_id: string): DeliverFrame => ({
  v: 1,
  id: `d-${msg_id}`,
  type: "deliver",
  msg_id,
  to_ref: "A",
  from_name: "peer",
  namespace: "ns",
  body: "hi",
});

describe("createDeliver", () => {
  it("logs, never leaks, a rejection from the settle handler", async () => {
    const agents = new AgentTable();
    agents.up({
      ref: "A",
      kind: "pi",
      proposedName: "a",
      busName: "a",
      namespace: "ns",
      global: false,
      pid: 1,
      cwd: "/",
      live: true,
    });
    const leaked = vi.fn();
    process.on("unhandledRejection", leaked);
    let finish!: () => void;
    const log = vi.fn();
    const d = createDeliver({
      agents,
      hub: {
        send: () => {
          throw new Error("socket gone");
        },
      },
      transports: {
        pi: () =>
          new Promise((r) => {
            finish = () => r({ ok: true });
          }),
      },
      onClosed: () => {},
      log,
    });
    try {
      const first = d.deliver(frame("mmmmmmmmmmmmmmm1"));
      const joined = d.deliver(frame("mmmmmmmmmmmmmmm1"));
      finish();
      await expect(first).resolves.toBeUndefined();
      await expect(joined).resolves.toBeUndefined();
      await new Promise((r) => setTimeout(r, 20));
      expect(leaked).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/socket gone/));
    } finally {
      process.off("unhandledRejection", leaked);
    }
  });
});
