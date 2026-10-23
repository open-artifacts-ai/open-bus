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

// Fixture names (src/mocks/fixtures.ts). GET /agents lists every agent that
// can receive mail: live ones and queued ones (machine offline, session open).
const APP = "github.com/acme/app";
const DOCS = "github.com/acme/docs";
const GLOBAL = "Global agents";
const [CLAUDE, OPENCODE, SCOUT] = fixtures.agents;
if (
  CLAUDE?.name !== "claude-1" ||
  CLAUDE.machineLabel !== "studio-mbp" ||
  OPENCODE?.name !== "opencode-1" ||
  OPENCODE.state !== "queued" ||
  OPENCODE.machineLabel !== "travel-air" ||
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

/** A non-global docs agent, so the docs namespace has a group of its own. */
const WRITER = agent({
  id: "AgentWriter1Ffff",
  name: "writer",
  namespace: DOCS,
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

const push = (agents: Agent[]) =>
  act(() => {
    lastSource().push({ type: "agents", agents });
  });

const names = (region: HTMLElement) =>
  within(region)
    .getAllByRole("listitem")
    .map((li) => li.textContent ?? "");

const filter = () => screen.getByRole("radiogroup", { name: "Namespace" });
const regionNames = () =>
  screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));

/** Counts agents GETs from here on, holding each until released. */
const countAgentGets = (bus: ReturnType<typeof createMockBus>) => {
  const seen = { gets: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server.use(
    http.get("*/api/v1/agents", async () => {
      seen.gets++;
      await gate;
      return HttpResponse.json({ agents: bus.agents() });
    }),
  );
  return { seen, release: () => act(async () => release()) };
};

test("agents are grouped by namespace; global ones sit only in the Global agents group", async () => {
  mount();
  const app = await screen.findByRole("region", { name: APP });
  expect(names(app)).toHaveLength(2);
  expect(names(app)[0]).toContain("claude-1");
  expect(names(app)[1]).toContain("opencode-1");
  const global = screen.getByRole("region", { name: GLOBAL });
  expect(within(global).getByText("scout")).toBeInTheDocument();
  expect(within(global).getByText("global")).toBeInTheDocument();
  // scout's home namespace gets no heading of its own.
  expect(screen.queryByRole("region", { name: DOCS })).not.toBeInTheDocument();
  expect(within(app).queryByText("global")).not.toBeInTheDocument();
});

test("namespaces are alphabetical, with Global agents last", async () => {
  mount();
  await screen.findByText("claude-1");
  push([WRITER, ...fixtures.agents]);
  await screen.findByText("writer");
  expect(
    regionNames().filter((n) => n?.startsWith("github.com/") || n === GLOBAL),
  ).toEqual([APP, DOCS, GLOBAL]);
  const docs = screen.getByRole("region", { name: DOCS });
  expect(names(docs)).toHaveLength(1);
  expect(within(docs).queryByText("scout")).not.toBeInTheDocument();
});

test("a queued agent shows Queued, after the live ones, labeled with its machine", async () => {
  mount();
  const app = await screen.findByRole("region", { name: APP });
  await waitFor(() => expect(names(app)).toHaveLength(2));
  expect(names(app)[1]).toContain("opencode-1");
  const chip = within(app).getByLabelText("opencode-1 on travel-air is queued");
  expect(chip).toHaveTextContent("Queued");
  expect(chip).not.toHaveTextContent("Live");
  expect(
    within(app).getByLabelText("claude-1 on studio-mbp is live"),
  ).toHaveTextContent("Live");
});

test("the live dot is labeled with the agent and its machine", async () => {
  mount();
  const app = await screen.findByRole("region", { name: APP });
  expect(
    within(app).getByLabelText("claude-1 on studio-mbp is live"),
  ).toBeInTheDocument();
  const global = screen.getByRole("region", { name: GLOBAL });
  expect(
    within(global).getByLabelText("scout on studio-mbp is live"),
  ).toBeInTheDocument();
});

test("same-named agents on two machines get distinct labels", async () => {
  mount();
  await screen.findByText("claude-1");
  push([
    CLAUDE,
    agent({
      id: "AgentTwin1Kkkkkk",
      name: "claude-1",
      machineId: fixtures.machines[1]?.id,
      machineLabel: "old-thinkpad",
    }),
  ]);
  expect(
    await screen.findByLabelText("claude-1 on old-thinkpad is live"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("claude-1 on studio-mbp is live"),
  ).toBeInTheDocument();
});

test("an agent that turns queued in a frame sorts after the live ones and says so", async () => {
  mount();
  await screen.findByText("claude-1");
  push([
    agent({ id: "AgentAaaDwn1Eeee", name: "aaa-q", state: "queued" }),
    ...fixtures.agents,
  ]);
  const app = screen.getByRole("region", { name: APP });
  await waitFor(() => expect(names(app)).toHaveLength(3));
  expect(names(app)[0]).toContain("claude-1");
  expect(names(app)[1]).toContain("aaa-q");
  expect(names(app)[2]).toContain("opencode-1");
  expect(
    within(app).getByLabelText("aaa-q on studio-mbp is queued"),
  ).toHaveTextContent("Queued");
});

test("a pushed roster frame updates the page without a reload", async () => {
  mount();
  await screen.findByText("claude-1");
  push([...fixtures.agents, agent({})]);
  expect(await screen.findByText("claude-2")).toBeInTheDocument();
});

test("the namespace filter narrows the groups; Global agents stay in every view", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  push([...fixtures.agents, WRITER]);
  await screen.findByText("writer");

  await user.click(within(filter()).getByRole("radio", { name: APP }));
  expect(screen.getByText("claude-1")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: DOCS })).not.toBeInTheDocument();
  expect(screen.queryByText("writer")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("region", { name: GLOBAL })).getByText("scout"),
  ).toBeInTheDocument();

  await user.click(within(filter()).getByRole("radio", { name: DOCS }));
  expect(screen.queryByRole("region", { name: APP })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: DOCS })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: GLOBAL })).toBeInTheDocument();

  await user.click(within(filter()).getByRole("radio", { name: "All" }));
  expect(screen.getByRole("region", { name: APP })).toBeInTheDocument();
});

test("filter chips carry the full namespace as a title", async () => {
  mount();
  await screen.findByText("claude-1");
  push([...fixtures.agents, WRITER]);
  await screen.findByText("writer");
  expect(within(filter()).getByRole("radio", { name: APP })).toHaveAttribute(
    "title",
    APP,
  );
});

test("a picked namespace that leaves the roster resets to All and stays there", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("claude-1");
  push([...fixtures.agents, WRITER]);
  await screen.findByText("writer");
  await user.click(within(filter()).getByRole("radio", { name: APP }));

  const other = agent({ id: "AgentYther1Ggggg", namespace: "x/y" });
  push([other, WRITER, SCOUT]);
  expect(
    await screen.findByRole("region", { name: "x/y" }),
  ).toBeInTheDocument();
  expect(within(filter()).getByRole("radio", { name: "All" })).toBeChecked();

  // app comes back: the view does not snap back to it.
  push([CLAUDE, other, WRITER, SCOUT]);
  expect(await screen.findByRole("region", { name: APP })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: DOCS })).toBeInTheDocument();
  expect(within(filter()).getByRole("radio", { name: "All" })).toBeChecked();
});

test("connecting shows no paused flash; the status region is mounted empty", async () => {
  mount();
  await screen.findByText("claude-1");
  const region = screen.getByRole("status");
  expect(region).toBeEmptyDOMElement();
  expect(
    screen.getByLabelText("claude-1 on studio-mbp is live"),
  ).toBeInTheDocument();
});

test("a dropped stream shows a paused banner, the rows stay, and none claims to be live now", async () => {
  mount();
  await screen.findByText("claude-1");
  const region = screen.getByRole("status");
  const dropped = lastSource();
  act(() => {
    lastSource().push({ type: "hello" });
    lastSource().fail();
  });
  await waitFor(() =>
    expect(region).toHaveTextContent(
      /^Live updates paused\. Showing the roster as of .+\.$/,
    ),
  );
  expect(screen.getByRole("status")).toBe(region);
  // The status region holds only the text; Retry sits beside it.
  expect(within(region).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByText("claude-1")).toBeInTheDocument();
  expect(screen.getByText("scout")).toBeInTheDocument();
  expect(screen.queryByLabelText(/ is live$/)).not.toBeInTheDocument();
  const chip = screen.getByLabelText(/^claude-1 on studio-mbp, live as of .+/);
  // The badge word never changes.
  expect(chip).toHaveTextContent("Live");
  // Queued agents are muted the same way.
  expect(screen.queryByLabelText(/ is queued$/)).not.toBeInTheDocument();
  const queued = screen.getByLabelText(
    /^opencode-1 on travel-air, queued as of .+/,
  );
  expect(queued).toHaveTextContent("Queued");
  expect(queued).toHaveClass("opacity-60");

  // Back live (the backoff reconnect says hello): labels say live again
  // and the banner clears.
  await waitFor(() => expect(lastSource()).not.toBe(dropped), {
    timeout: 3000,
  });
  act(() => lastSource().push({ type: "hello" }));
  expect(
    await screen.findByLabelText("claude-1 on studio-mbp is live"),
  ).toBeInTheDocument();
  expect(
    screen.getByLabelText("opencode-1 on travel-air is queued"),
  ).not.toHaveClass("opacity-60");
  expect(region).toBeEmptyDOMElement();
});

test("Retry while the stream backs off refetches the roster once, however fast you click", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("claude-1");
  act(() => lastSource().push({ type: "hello" }));
  // Let hello's refetch settle before counting.
  await new Promise((r) => setTimeout(r, 50));
  act(() => lastSource().fail());
  const retry = await screen.findByRole("button", { name: "Retry" });

  bus.setAgents([
    CLAUDE,
    SCOUT,
    agent({ id: "AgentNew2Hhhhhhh", name: "fresh" }),
  ]);
  const { seen, release } = countAgentGets(bus);
  await user.click(retry);
  await user.click(retry);
  expect(seen.gets).toBe(1);
  expect(retry).toBeDisabled();
  await release();
  expect(await screen.findByText("fresh")).toBeInTheDocument();
  expect(seen.gets).toBe(1);
});

test("Retry reconnects a parked stream and leaves the refetch to its hello", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("claude-1");
  // A failure before any hello parks the stream until retry().
  act(() => lastSource().fail());
  const region = screen.getByRole("status");
  await waitFor(() => expect(region).toHaveTextContent(/live updates paused/i));
  const parked = lastSource();
  const { seen, release } = countAgentGets(bus);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(lastSource()).not.toBe(parked);
  expect(seen.gets).toBe(0);
  act(() => lastSource().push({ type: "hello" }));
  await waitFor(() => expect(region).toBeEmptyDOMElement());
  await waitFor(() => expect(seen.gets).toBe(1));
  await release();
  expect(seen.gets).toBe(1);
});

test("no agents shows how to start one", async () => {
  mount();
  await screen.findByText("claude-1");
  push([]);
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
