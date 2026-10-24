import { defineConfig, devices } from "@playwright/test";

// The real-server suite (FE9): no mocks, no webServer. The operator starts the
// server (local `wrangler dev`, or staging) and this points at it.
//   OB_E2E_BASE        default http://localhost:8787
//   E2E_STORAGE_STATE  staging: a storageState file from one real Access login
// Without E2E_STORAGE_STATE the dev-login fixture signs in (dev + loopback only).
const storageState = process.env.E2E_STORAGE_STATE || undefined;

export default defineConfig({
  testDir: "e2e/real",
  // No retries: a flake is a failure. One worker: not-you.spec.ts ends the session.
  retries: 0,
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: process.env.OB_E2E_BASE ?? "http://localhost:8787",
    ...(storageState ? { storageState } : {}),
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
