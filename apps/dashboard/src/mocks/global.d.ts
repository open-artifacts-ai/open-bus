import type { MockBus } from "./handlers";

declare global {
  interface Window {
    /** VITE_MOCK only: the mock bus, so an e2e test can push roster frames. */
    __obMock?: MockBus;
  }
}
