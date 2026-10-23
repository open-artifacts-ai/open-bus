import { HttpResponse, http } from "msw";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { api } from "../src/api/client";
import { installHarness, server } from "./harness";

installHarness();
afterEach(() => vi.restoreAllMocks());

test("contract codes csrf, conflict and too_large survive", async () => {
  for (const [code, status] of [
    ["csrf", 403],
    ["conflict", 409],
    ["too_large", 413],
  ] as const) {
    server.use(
      http.post("*/api/v1/x", () =>
        HttpResponse.json({ error: { code, message: "m" } }, { status }),
      ),
    );
    const err = await api.send("POST", "/api/v1/x").catch((e) => e);
    expect(err).toMatchObject({ code, status });
  }
});

test("a non-JSON body falls back by status", async () => {
  const cases = [
    [429, "rate_limited"],
    [401, "unauthorized"],
    [404, "not_found"],
    [400, "bad_request"],
    [502, "internal"],
  ] as const;
  for (const [status, code] of cases) {
    server.use(
      http.get("*/api/v1/y", () => new HttpResponse("slow down", { status })),
    );
    const err = await api.get("/api/v1/y", z.unknown()).catch((e) => e);
    expect(err).toMatchObject({ code, status });
  }
});

test("an abort while reading the body stays an AbortError", async () => {
  const ac = new AbortController();
  const abort = () => new DOMException("aborted", "AbortError");
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          ac.abort();
          throw abort();
        },
      }) as unknown as Response,
  );
  const err = await api
    .get("/api/v1/me", z.unknown(), ac.signal)
    .catch((e) => e);
  expect((err as Error).name).toBe("AbortError");

  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      ({
        ok: false,
        status: 500,
        text: async () => {
          throw abort();
        },
      }) as unknown as Response,
  );
  const err2 = await api.get("/api/v1/me", z.unknown()).catch((e) => e);
  expect((err2 as Error).name).toBe("AbortError");
});
