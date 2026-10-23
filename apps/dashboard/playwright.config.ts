import { defineConfig, devices } from "@playwright/test";

// E2E_PORT: run beside another checkout (OA's mock runner also uses 5199).
const port = Number(process.env.E2E_PORT ?? 5199);

// The mock runner (OA's shape): Vite with VITE_MOCK=1, so MSW serves the API
// and the stream from @ob/shared/mocks, and window.__obMock pushes frames.
// Every page load starts from the fixtures: mock state lives in the page.
export default defineConfig({
  testDir: "e2e",
  // No retries: a flake is a failure.
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    env: { VITE_MOCK: "1" },
    reuseExistingServer: false,
  },
});
