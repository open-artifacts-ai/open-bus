import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { FakeEventSource } from "./fakeEventSource";

afterEach(() => {
  cleanup();
  FakeEventSource.all = [];
});

// jsdom has no EventSource, and the signed-in shell opens one (useBusEvents).
// Tests that install their own fake (installFakeEventSource) still can.
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

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
