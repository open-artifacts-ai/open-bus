import { expect, test } from "vitest";
import { safeNext } from "../src/auth/safeNext";

test.each([
  ["/", "/"],
  ["/agents", "/agents"],
  ["/agents?x=1#h", "/agents?x=1#h"],
  ["/machines/abc", "/machines/abc"],
])("keeps the same-origin path %s", (input, out) => {
  expect(safeNext(input)).toBe(out);
});

test.each([
  "",
  "agents",
  "//evil.com",
  "/\\evil.com",
  "/\\/evil.com",
  "https://evil.com",
  "/auth/logout",
  "/auth",
  "/AUTH/login",
  "/api/v1/me",
  "/api",
  " /agents",
])("falls back to / for %j", (input) => {
  expect(safeNext(input)).toBe("/");
});
