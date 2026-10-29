import { HttpResponse, http } from "msw";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { type ApiClientError, api } from "../src/api/client";
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

test("details.field survives, so a form can put the message on that field", async () => {
  server.use(
    http.put("*/api/v1/z", () =>
      HttpResponse.json(
        {
          error: {
            code: "bad_request",
            message: "closed",
            details: { field: "agentId" },
          },
        },
        { status: 400 },
      ),
    ),
  );
  const err = await api.send("PUT", "/api/v1/z", {}).catch((e) => e);
  expect(err).toMatchObject({ code: "bad_request", field: "agentId" });
  server.use(
    http.put("*/api/v1/z", () =>
      HttpResponse.json(
        { error: { code: "bad_request", message: "m", details: { field: 3 } } },
        { status: 400 },
      ),
    ),
  );
  const bad = await api.send("PUT", "/api/v1/z", {}).catch((e) => e);
  expect((bad as ApiClientError).field).toBeUndefined();
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

test("rate_limited carries details.retryAfterSec; bad or missing details leave it undefined", async () => {
  const cases = [
    [{ retryAfterSec: 30 }, 30],
    [{ retryAfterSec: -1 }, undefined],
    [{ retryAfterSec: "30" }, undefined],
    [undefined, undefined],
  ] as const;
  for (const [details, want] of cases) {
    server.use(
      http.get("*/api/v1/z", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow down", details } },
          { status: 429 },
        ),
      ),
    );
    const err = await api.get("/api/v1/z", z.unknown()).catch((e) => e);
    expect(err).toMatchObject({ code: "rate_limited", status: 429 });
    expect((err as ApiClientError).retryAfterSec).toBe(want);
  }
});

test("an HTTP 401 is always unauthorized, whatever code the body names", async () => {
  for (const code of ["internal", "bad_request", "not_found", "csrf"]) {
    server.use(
      http.get("*/api/v1/w", () =>
        HttpResponse.json({ error: { code, message: "m" } }, { status: 401 }),
      ),
    );
    const err = await api.get("/api/v1/w", z.unknown()).catch((e) => e);
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
  }
});

test("a body outside the shared envelope falls back by status", async () => {
  server.use(
    http.get("*/api/v1/flat", () =>
      HttpResponse.json(
        { code: "conflict", message: "flat shape" },
        { status: 404 },
      ),
    ),
  );
  const err = await api.get("/api/v1/flat", z.unknown()).catch((e) => e);
  expect(err).toMatchObject({ code: "not_found", status: 404 });
  expect((err as Error).message).toBe("Unexpected response (HTTP 404)");
});
