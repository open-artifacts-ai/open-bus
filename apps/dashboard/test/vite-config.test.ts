import { expect, test } from "vitest";
import config from "../vite.config";

test("the dev proxy forwards /api WebSocket upgrades (the live events socket)", () => {
  const resolved = (
    config as (env: { mode: string; command: string }) => {
      server?: { proxy?: Record<string, unknown> };
    }
  )({ mode: "development", command: "serve" });
  expect(resolved.server?.proxy?.["/api"]).toEqual({
    target: "http://localhost:8787",
    ws: true,
  });
});
