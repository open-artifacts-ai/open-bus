import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { z } from "zod";
import { ApiClientError, api } from "../src/api/client";
import { BusEventSchema } from "../src/api/contract";
import { installHarness, server } from "./harness";

installHarness();

const wire = (body: Parameters<typeof HttpResponse.json>[0], status = 200) =>
  HttpResponse.json(body, { status });

test("parses a valid body through its schema", async () => {
  server.use(http.get("*/api/v1/me", () => wire({ user: { id: "u1" } })));
  const me = await api.get(
    "/api/v1/me",
    z.object({ user: z.object({ id: z.string() }) }),
  );
  expect(me.user.id).toBe("u1");
});

test("a 404 becomes ApiClientError(not_found) carrying the server message", async () => {
  server.use(
    http.delete("*/api/v1/machines/m1", () =>
      HttpResponse.json(
        { error: { code: "not_found", message: "No such machine" } },
        { status: 404 },
      ),
    ),
  );
  const err = await api.send("DELETE", "/api/v1/machines/m1").catch((e) => e);
  expect(err).toBeInstanceOf(ApiClientError);
  expect(err).toMatchObject({
    code: "not_found",
    status: 404,
    message: "No such machine",
  });
});

test("mutations carry the CSRF header", async () => {
  let seen: string | null = null;
  server.use(
    http.delete("*/api/v1/machines/m1", ({ request }) => {
      seen = request.headers.get("X-OB-Request");
      return new HttpResponse(null, { status: 204 });
    }),
  );
  await api.send("DELETE", "/api/v1/machines/m1");
  expect(seen).toBe("1");
});

test("an unparseable body is an internal error, not a crash", async () => {
  server.use(http.get("*/api/v1/me", () => wire({ nope: true })));
  const err = await api
    .get("/api/v1/me", z.object({ user: z.string() }))
    .catch((e) => e);
  expect(err).toMatchObject({ code: "internal" });
});

test("BusEventSchema accepts a snapshot frame and rejects an unknown type", () => {
  expect(BusEventSchema.safeParse({ type: "agents", agents: [] }).success).toBe(
    true,
  );
  expect(BusEventSchema.safeParse({ type: "wat" }).success).toBe(false);
});
