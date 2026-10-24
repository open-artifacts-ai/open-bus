import { expect, test } from "vitest";
import { safeNext } from "../src/auth/safeNext";

const ORIGIN = "https://bus.example";
const next = (p: string) => safeNext(p, ORIGIN);

test.each([
  ["/", "/"],
  ["/agents", "/agents"],
  ["/agents?x=1#h", "/agents?x=1#h"],
  ["/machines/abc", "/machines/abc"],
  // Encoded and dot-segment paths may pass once resolved: same origin, outside the Worker.
  ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
  ["/a/../agents", "/agents"],
  ["/./agents", "/agents"],
  ["/%61uth/x", "/%61uth/x"],
])("keeps the same-origin path %j as %j", (input, out) => {
  expect(next(input)).toBe(out);
});

test.each([
  "",
  "agents",
  "//evil.com",
  "//evil.com/agents",
  "///evil.com/agents",
  "/\\evil.com",
  "/\\/evil.com",
  "https://evil.com",
  "/auth/logout",
  "/auth",
  "/AUTH/login",
  "/api/v1/me",
  "/api",
  "/Api?x=1",
  " /agents",
  // URL parsers strip tab, CR and LF: "/\t/evil.com" would become "//evil.com".
  "/\t/evil.com",
  "/\r/evil.com",
  "/\n/evil.com",
  "/\u0000/evil.com",
  "/\u001f/evil.com",
  "/\u007f/evil.com",
  "/agents\t",
  // Dot segments that land in the Worker's paths.
  "/x/../auth/logout",
  "/./api/v1/me",
  "/agents/%2e%2e/api/v1/me",
])("falls back to / for %j", (input) => {
  expect(next(input)).toBe("/");
});

test("resolves against the given origin", () => {
  expect(safeNext("/agents", "http://localhost:5173")).toBe("/agents");
});
