import { setupWorker } from "msw/browser";
import { createMockBus, handlersFor } from "./handlers";

/**
 * Dev and e2e only (`VITE_MOCK=1`). Exposes the bus on `window.__obMock` so a
 * Playwright test can push a roster frame without a real hub.
 */
export async function startMocks() {
  const bus = createMockBus();
  const worker = setupWorker(...handlersFor(bus));
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
  window.__obMock = bus;
}
