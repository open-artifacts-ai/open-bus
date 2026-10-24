import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { FakeWebSocket, installFakeWebSocket } from "./fakeWebSocket";

afterEach(() => {
  cleanup();
  FakeWebSocket.all = [];
});

// The signed-in shell opens a WebSocket (useBusEvents). jsdom's would dial
// out and msw's node interceptor (patched in at server.listen) would answer
// it, so every test gets the fake, installed after any beforeAll.
installFakeWebSocket();
beforeEach(installFakeWebSocket);

// jsdom has no matchMedia; the sidebar (useIsMobile) and theme hook read it.
if (!window.matchMedia)
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
