import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Hub, HubStub } from "../src/hub/do.js";
import { e } from "./helpers.js";

const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;

// A close or error event for a socket this DO never accepted (getTags throws)
// has nothing to clean up and must not throw out of the handler.
describe("socket events for a socket the hub never accepted", () => {
  for (const event of ["webSocketClose", "webSocketError"] as const)
    it(`${event} returns quietly`, async () => {
      const h = freshHub();
      await runInDurableObject(
        h as unknown as DurableObjectStub<Hub>,
        async (i: Hub) => {
          const [, server] = Object.values(new WebSocketPair());
          const run =
            event === "webSocketClose"
              ? i.webSocketClose(server, 1000)
              : i.webSocketError(server, new Error("x"));
          await expect(run).resolves.toBeUndefined();
        },
      );
    });
});
