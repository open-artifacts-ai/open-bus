import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { FakeEventSource } from "./fakeEventSource";
import { installHarness, server } from "./harness";

installHarness();

const mount = (path: string) =>
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider
        router={createAppRouter(
          createMemoryHistory({ initialEntries: [path] }),
        )}
      />
    </QueryClientProvider>,
  );

const anonymous = () =>
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "Sign in" } },
        { status: 401 },
      ),
    ),
  );

test("an anonymous visitor gets the sign-in page, not an empty dashboard", async () => {
  anonymous();
  mount("/");
  expect(
    await screen.findByRole("heading", { name: /sign in/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: /continue with cloudflare/i }),
  ).toHaveAttribute("href", expect.stringContaining("/auth/login"));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  // No live stream for a visitor who isn't signed in.
  expect(FakeEventSource.all).toHaveLength(0);
});

test("sign-in sends the visitor back to the page they asked for", async () => {
  anonymous();
  mount("/agents");
  const link = await screen.findByRole("link", {
    name: /continue with cloudflare/i,
  });
  expect(link).toHaveAttribute(
    "href",
    `/auth/login?next=${encodeURIComponent("/agents")}`,
  );
});

test("a failed /me (not a 401) says sign-in didn't finish", async () => {
  server.use(
    http.get("*/api/v1/me", () =>
      HttpResponse.json(
        { error: { code: "bad_request", message: "nope" } },
        { status: 400 },
      ),
    ),
  );
  mount("/");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /sign-in didn't finish/i,
  );
});

test("/sign-in?error shows the failure without the shell", async () => {
  anonymous();
  mount("/sign-in?error=access_denied");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    /sign-in didn't finish/i,
  );
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

test("a signed-in visitor sees the machines page", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  expect(
    await screen.findByRole("heading", { name: "Machines" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
    "href",
    "/agents",
  );
  expect(screen.getByRole("link", { name: "Machines" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: "Agents" })).not.toHaveAttribute(
    "aria-current",
  );
  await waitFor(() => expect(document.title).toBe("Machines · OpenBus"));
});

test("the agents tab is current on /agents", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/agents");
  expect(
    await screen.findByRole("heading", { name: "Agents" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("the shell opens exactly one live stream", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  expect(FakeEventSource.all[0]?.url).toContain("/api/v1/events");
});

test("an unknown path is a 404 inside the shell", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/nope");
  expect(
    await screen.findByRole("heading", { name: /not found/i }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Machines" })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe("Not found · OpenBus"));
});
