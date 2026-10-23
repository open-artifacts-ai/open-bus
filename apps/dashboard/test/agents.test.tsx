import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import type { Agent } from "../src/api/contract";
import { makeQueryClient } from "../src/api/queryClient";
import { fixtures } from "../src/mocks/fixtures";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { lastSource } from "./fakeEventSource";
import { installHarness, server } from "./harness";

installHarness();

// Fixture names (src/mocks/fixtures.ts). GET /agents lists live agents only,
// so opencode-1 (offline) is never served.
const APP = "repo:github.com/acme/app";
const DOCS = "repo:github.com/acme/docs";
const [CLAUDE, OPENCODE, SCOUT] = fixtures.agents;
if (
  CLAUDE?.name !== "claude-1" ||
  OPENCODE?.name !== "opencode-1" ||
  OPENCODE.live ||
  SCOUT?.name !== "scout" ||
  !SCOUT.global ||
  SCOUT.namespace !== DOCS
)
  throw new Error("fixtures changed: update agents.test.tsx");

const agent = (over: Partial<Agent>): Agent => ({
  ...CLAUDE,
  id: "AgentExtra1Ddddd",
  name: "claude-2",
  updatedAt: new Date().toISOString(),
  ...over,
});

/** Signed-in app at `/agents`, backed by a fresh mock bus. No retries. */
const mount = (client: QueryClient = makeQueryClient()) => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createAppRouter(
          createMemoryHistory({ initialEntries: ["/agents"] }),
        )}
      />
    </QueryClientProvider>,
  );
  return bus;
};

const names = (region: HTMLElement) =>
  within(region)
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

test("agents are grouped by namespace, global ones badged", async () => {
  mount();
  const app = await screen.findByRole("region", { name: APP });
  expect(names(app)).toHaveLength(1);
  expect(names(app)[0]).toContain("claude-1");
  const docs = screen.getByRole("region", { name: DOCS });
  expect(within(docs).getByText("scout")).toBeInTheDocument();
  expect(within(docs).getByText("global")).toBeInTheDocument();
  expect(within(app).queryByText("global")).not.toBeInTheDocument();
  // Namespaces are alphabetical.
  const regions = screen
    .getAllByRole("region")
    .map((r) => r.getAttribute("aria-label"));
  expect(regions.filter((n) => n?.startsWith("repo:"))).toEqual([APP, DOCS]);
});

test("shows exactly what the server returns: no offline agents are invented", async () => {
  mount();
  await screen.findByText("claude-1");
  expect(screen.queryByText("opencode-1")).not.toBeInTheDocument();
});

test("the live dot is labeled for screen readers", async () => {
  mount();
  const app = await screen.findByRole("region", { name: APP });
  expect(within(app).getByLabelText("claude-1 is live")).toBeInTheDocument();
  const docs = screen.getByRole("region", { name: DOCS });
  expect(within(docs).getByLabelText("scout is live")).toBeInTheDocument();
});

test("an offline agent the server sends sorts after the live ones and says so", async () => {
  mount();
  await screen.findByText("claude-1");
  act(() => {
    lastSource().push({
      type: "agents",
      agents: [
        agent({ id: "AgentAaaDwn1Eeee", name: "aaa-off", live: false }),
        ...fixtures.agents.filter((a) => a.live),
      ],
    });
  });
  const app = screen.getByRole("region", { name: APP });
  await waitFor(() => expect(names(app)).toHaveLength(2));
  expect(names(app)[0]).toContain("claude-1");
  expect(names(app)[1]).toContain("aaa-off");
  expect(within(app).getByLabelText("aaa-off is offline")).toBeInTheDocument();
});

test("a pushed roster frame updates the page without a reload", async () => {
  mount();
  await screen.findByText("claude-1");
  act(() => {
    lastSource().push({
      type: "agents",
      agents: [...fixtures.agents.filter((a) => a.live), agent({})],
    });
  });
  expect(await screen.findByText("claude-2")).toBeInTheDocument();
});

test("the namespace filter narrows the groups", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  const filter = screen.getByRole("radiogroup", { name: "Namespace" });
  await user.click(within(filter).getByRole("radio", { name: DOCS }));
  expect(screen.queryByRole("region", { name: APP })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: DOCS })).toBeInTheDocument();

  await user.click(within(filter).getByRole("radio", { name: "All" }));
  expect(screen.getByRole("region", { name: APP })).toBeInTheDocument();
});

test("global agents stay in every filtered view; other namespaces' agents don't", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  act(() => {
    lastSource().push({
      type: "agents",
      agents: [
        ...fixtures.agents.filter((a) => a.live),
        agent({ id: "AgentWriter1Ffff", name: "writer", namespace: DOCS }),
      ],
    });
  });
  await screen.findByText("writer");
  const filter = screen.getByRole("radiogroup", { name: "Namespace" });
  await user.click(within(filter).getByRole("radio", { name: APP }));
  expect(screen.getByText("claude-1")).toBeInTheDocument();
  expect(screen.getByText("scout")).toBeInTheDocument();
  expect(screen.queryByText("writer")).not.toBeInTheDocument();
});

test("a selected namespace that leaves the roster falls back to all", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  const filter = screen.getByRole("radiogroup", { name: "Namespace" });
  await user.click(within(filter).getByRole("radio", { name: APP }));
  act(() => {
    lastSource().push({
      type: "agents",
      agents: [agent({ id: "AgentYther1Ggggg", namespace: "repo:x/y" }), SCOUT],
    });
  });
  expect(
    await screen.findByRole("region", { name: "repo:x/y" }),
  ).toBeInTheDocument();
});

test("connecting shows no paused flash; the status region is mounted empty", async () => {
  mount();
  await screen.findByText("claude-1");
  const region = screen.getByRole("status");
  expect(region).toBeEmptyDOMElement();
});

test("a dropped stream shows a paused chip with retry, and the rows stay", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("claude-1");
  const region = screen.getByRole("status");
  act(() => {
    lastSource().push({ type: "hello" });
    lastSource().fail();
  });
  await waitFor(() => expect(region).toHaveTextContent(/live updates paused/i));
  expect(screen.getByRole("status")).toBe(region);
  expect(screen.getByText("claude-1")).toBeInTheDocument();
  expect(screen.getByText("scout")).toBeInTheDocument();

  // Retry reloads the roster from the server.
  bus.setAgents([
    CLAUDE,
    SCOUT,
    agent({ id: "AgentNew2Hhhhhhh", name: "fresh" }),
  ]);
  await user.click(within(region).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("fresh")).toBeInTheDocument();
});

test("no agents shows how to start one", async () => {
  mount();
  await screen.findByText("claude-1");
  act(() => {
    lastSource().push({ type: "agents", agents: [] });
  });
  expect(await screen.findByText(/no agents connected/i)).toBeInTheDocument();
  expect(screen.getByText(/npx open-bus/)).toBeInTheDocument();
  expect(
    screen.queryByRole("radiogroup", { name: "Namespace" }),
  ).not.toBeInTheDocument();
});

test("loading shows a skeleton", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  mount();
  server.use(
    http.get("*/api/v1/agents", async () => {
      await gate;
      return HttpResponse.json({ agents: [] });
    }),
  );
  expect(
    await screen.findByRole("region", { name: "Loading agents" }),
  ).toHaveAttribute("aria-busy", "true");
  await act(async () => release());
  expect(await screen.findByText(/no agents connected/i)).toBeInTheDocument();
});

test("an error offers Try again, which recovers", async () => {
  const user = userEvent.setup();
  let fail = true;
  mount();
  server.use(
    http.get("*/api/v1/agents", () =>
      fail
        ? HttpResponse.json(
            { error: { code: "internal", message: "Hub unreachable" } },
            { status: 500 },
          )
        : HttpResponse.json({ agents: [CLAUDE] }),
    ),
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/couldn't load your agents/i);
  expect(alert).toHaveTextContent("Hub unreachable");
  fail = false;
  await user.click(within(alert).getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("claude-1")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("the page title names the page", async () => {
  mount();
  await screen.findByText("claude-1");
  expect(document.title).toMatch(/^Agents/);
});

test("Retry reconnects a parked stream", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  // A failure before any hello parks the stream until retry().
  act(() => lastSource().fail());
  const region = screen.getByRole("status");
  await waitFor(() => expect(region).toHaveTextContent(/live updates paused/i));
  const parked = lastSource();
  await user.click(within(region).getByRole("button", { name: "Retry" }));
  expect(lastSource()).not.toBe(parked);
  act(() => lastSource().push({ type: "hello" }));
  await waitFor(() => expect(region).toBeEmptyDOMElement());
});
