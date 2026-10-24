import { R } from "@ob/shared/web";
import { createMemoryHistory } from "@tanstack/react-router";
import { expect, test } from "vitest";
import { createAppRouter } from "../src/router";

// The dashboard's real pages (router.tsx). Anything else renders NotFound.
const PAGES = ["/", "/agents", "/sign-in"];

const leafRouteId = (path: string) => {
  const matches = createAppRouter(createMemoryHistory()).matchRoutes(path);
  return matches[matches.length - 1]?.routeId;
};

// The Worker redirects to R.dashboard after a device approval
// (apps/server/src/routes/approve.ts). It must land on a real page, never
// NotFound (prod bug: "/machines" had no route).
test("R.dashboard resolves to a real dashboard page", () => {
  expect(PAGES).toContain(leafRouteId(R.dashboard));
});

test("control: a path with no page (the old /machines) is not a real page", () => {
  expect(PAGES).not.toContain(leafRouteId("/machines"));
});
