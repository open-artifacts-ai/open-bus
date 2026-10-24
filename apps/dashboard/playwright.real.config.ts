import { defineConfig, devices } from "@playwright/test";

// The real-server suite (FE9): no mocks.
//   Local (OB_E2E_BASE unset or loopback, no E2E_STORAGE_STATE): a webServer runs
//   e2e/real/serve.mjs, a local https `wrangler dev` with dev placeholders and
//   fresh state; the dev-login fixture signs in. Default https://127.0.0.1:8791.
//   Staging (E2E_STORAGE_STATE, OB_E2E_BASE): no webServer; the storageState from
//   one real Access login signs in.
const storageState = process.env.E2E_STORAGE_STATE || undefined;
const baseURL = process.env.OB_E2E_BASE ?? "https://127.0.0.1:8791";
// Local `wrangler dev --local-protocol https` serves a self-signed cert.
const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(baseURL).hostname,
);
const local = loopback && !storageState;

export default defineConfig({
  testDir: "e2e/real",
  // No retries: a flake is a failure. One worker: not-you.spec.ts ends the session.
  retries: 0,
  workers: 1,
  forbidOnly: !!process.env.CI,
  use: {
    baseURL,
    ignoreHTTPSErrors: loopback,
    ...(storageState ? { storageState } : {}),
  },
  ...(local
    ? {
        webServer: {
          command: `node e2e/real/serve.mjs ${new URL(baseURL).port || "8791"}`,
          url: `${baseURL}/healthz`,
          ignoreHTTPSErrors: true,
          reuseExistingServer: !process.env.CI,
          // Cold CI: two builds, then wrangler starts.
          timeout: 300_000,
          stdout: "ignore",
        },
      }
    : {}),
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
