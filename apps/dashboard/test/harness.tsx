import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

export const server = setupServer();

/** Registers msw for a test file. `onUnhandledRequest: "error"` catches typo'd paths. */
export const installHarness = () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
    // Node has no page origin, so resolve the client's relative paths against one.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(
        typeof input === "string"
          ? new URL(input, "http://localhost").href
          : input,
        init,
      ),
    );
  });
  afterAll(() => {
    // Undo our wrapper first so msw restores the fetch it replaced, not ours.
    vi.unstubAllGlobals();
    server.close();
  });
  afterEach(() => server.resetHandlers());
};
