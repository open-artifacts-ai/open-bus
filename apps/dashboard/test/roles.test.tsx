import { toast } from "@ob/ui/shadcn";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import type { Agent } from "../src/api/contract";
import { makeQueryClient } from "../src/api/queryClient";
import { fixtures } from "../src/mocks/fixtures";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { lastSocket } from "./fakeWebSocket";
import { installHarness, server } from "./harness";
import { warmApp } from "./warm";

installHarness();
beforeAll(() => {
  // Radix Select reaches for pointer capture and scrollIntoView; jsdom has neither.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});
// Cold first render out of the first test's findBy budget (see warmApp).
beforeAll(warmApp, 30_000);
// Sonner keeps active toasts module-wide and replays them to the next Toaster.
afterEach(() => {
  toast.dismiss();
  vi.restoreAllMocks();
});

// Fixtures (src/mocks/fixtures.ts) and the mock bus's roles: lane-6 points
// at claude-1; reviewer is vacant. Both in github.com/acme/app.
const APP = "github.com/acme/app";
const DOCS = "github.com/acme/docs";
const [CLAUDE, OPENCODE, SCOUT] = fixtures.agents;
if (
  CLAUDE?.name !== "claude-1" ||
  CLAUDE.namespace !== APP ||
  OPENCODE?.name !== "opencode-1" ||
  OPENCODE.state !== "queued" ||
  SCOUT?.name !== "scout" ||
  !SCOUT.global
)
  throw new Error("fixtures changed: update roles.test.tsx");

/** A non-global docs agent, so docs is a namespace of its own. */
const WRITER: Agent = {
  ...CLAUDE,
  id: "AgentWriter1Ffff",
  name: "writer",
  namespace: DOCS,
};

const mount = (path = "/roles") => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createAppRouter(
          createMemoryHistory({ initialEntries: [path] }),
        )}
      />
    </QueryClientProvider>,
  );
  return bus;
};

/** The table row whose role is `role`. */
const rowOf = (role: string) => {
  const row = screen
    .getAllByRole("row", { hidden: true })
    .find((r) => within(r).queryByText(role, { selector: "bdi[data-role]" }));
  if (!row) throw new Error(`no row for ${role}`);
  return row;
};

const push = (agents: Agent[]) =>
  act(() => {
    lastSocket().push({ type: "agents", agents });
  });

/** Counts PUTs to roles from here on, passing each to `bus`. */
const countPuts = (bus: ReturnType<typeof createMockBus>) => {
  const seen: { body: unknown; url: string }[] = [];
  server.use(
    http.put("*/api/v1/roles/:ns/:role", async ({ request, params }) => {
      const body = await request.json();
      seen.push({ body, url: request.url });
      return bus.setRole(
        decodeURIComponent(String(params.ns)),
        decodeURIComponent(String(params.role)),
        body,
      );
    }),
  );
  return seen;
};

const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  combobox: string,
  option: string | RegExp,
) => {
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
};

test("lists each role pointing at its holder, with namespace and holder state", async () => {
  mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  const banner = screen.getByRole("banner");
  expect(
    within(banner).getByRole("heading", { level: 1, name: "Roles" }),
  ).toBeInTheDocument();
  const lane = rowOf("lane-6");
  expect(lane).toHaveTextContent("lane-6 → claude-1");
  expect(lane).toHaveTextContent(APP);
  expect(within(lane).getByText("Live")).toBeInTheDocument();
  const reviewer = rowOf("reviewer");
  expect(within(reviewer).getByText("Vacant")).toBeInTheDocument();
  expect(reviewer).not.toHaveTextContent("→");
  expect(document.title).toMatch(/^Roles/);
  expect(screen.getByRole("link", { name: "Roles, 2" })).toBeInTheDocument();
});

test("a queued holder reads Queued", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  // Point reviewer at the queued opencode-1.
  await user.click(screen.getByRole("button", { name: "Re-point reviewer" }));
  await pick(user, "Holder", /^opencode-1/);
  await user.click(screen.getByRole("button", { name: "Save role" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(bus.roles().find((r) => r.role === "reviewer")?.agentId).toBe(
    OPENCODE.id,
  );
  await waitFor(() =>
    expect(rowOf("reviewer")).toHaveTextContent("reviewer → opencode-1"),
  );
  expect(within(rowOf("reviewer")).getByText("Queued")).toBeInTheDocument();
});

test("no roles: the empty state explains what a role is", async () => {
  mount();
  server.use(
    http.get("*/api/v1/roles", () => HttpResponse.json({ roles: [] })),
  );
  expect(await screen.findByText("No roles yet")).toBeInTheDocument();
  expect(
    screen.getByText(
      "A role is a name, such as lane-6, that you point at one agent.",
    ),
  ).toBeInTheDocument();
});

test("Add role: namespace, name and holder; the holder lists open agents in that namespace plus global ones", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  bus.setAgents([...fixtures.agents, WRITER]);
  push(bus.agents());
  const puts = countPuts(bus);

  await user.click(screen.getByRole("button", { name: "Add role" }));
  const dialog = await screen.findByRole("dialog", { name: "Add role" });
  const ns = within(dialog).getByRole("combobox", { name: "Namespace" });
  expect(ns).toHaveTextContent(APP);

  await user.click(within(dialog).getByRole("combobox", { name: "Holder" }));
  const names = (await screen.findAllByRole("option")).map(
    (o) => o.textContent,
  );
  expect(names).toHaveLength(3);
  expect(names.join(" ")).toContain("opencode-1");
  expect(names.join(" ")).toContain("scout");
  expect(names.join(" ")).not.toContain("writer");
  // One role per agent: claude-1 holds lane-6.
  const held = screen.getByRole("option", { name: /^claude-1/ });
  expect(held).toHaveTextContent("holds lane-6");
  expect(held).toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");

  await pick(user, "Namespace", DOCS);
  await user.click(within(dialog).getByRole("combobox", { name: "Holder" }));
  const docs = (await screen.findAllByRole("option")).map((o) => o.textContent);
  expect(docs.join(" ")).toContain("writer");
  expect(docs.join(" ")).toContain("scout");
  expect(docs.join(" ")).not.toContain("opencode-1");
  await user.click(screen.getByRole("option", { name: /^writer/ }));

  await user.type(within(dialog).getByLabelText("Role name"), "docs-lead");
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(puts).toHaveLength(1);
  expect(puts[0]?.body).toEqual({ agentId: WRITER.id });
  expect(puts[0]?.url).toContain(
    `/api/v1/roles/${encodeURIComponent(DOCS)}/docs-lead`,
  );
  await screen.findByText("docs-lead", { selector: "bdi[data-role]" });
  expect(rowOf("docs-lead")).toHaveTextContent("docs-lead → writer");
});

test("an invalid role name is refused before any request", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  const puts = countPuts(bus);
  await user.click(screen.getByRole("button", { name: "Add role" }));
  const dialog = await screen.findByRole("dialog");
  await pick(user, "Holder", /^opencode-1/);
  const name = within(dialog).getByLabelText("Role name");
  await user.type(name, "bad/name");
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveAccessibleDescription(
    "Use letters, digits, spaces, dots, hyphens or underscores, starting with a letter or digit.",
  );
  expect(puts).toHaveLength(0);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("a 409 shows the server's message on the name; the dialog stays open with its input", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  await user.click(screen.getByRole("button", { name: "Add role" }));
  const dialog = await screen.findByRole("dialog");
  await pick(user, "Holder", /^opencode-1/);
  const name = within(dialog).getByLabelText("Role name");
  // An open agent's name: the hub refuses it 409 conflict.
  await user.type(name, "claude-1");
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  await waitFor(() =>
    expect(name).toHaveAccessibleDescription(
      '"claude-1" is already an open agent\'s name',
    ),
  );
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveValue("claude-1");
  expect(
    within(dialog).getByRole("combobox", { name: "Holder" }),
  ).toHaveTextContent("opencode-1");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("a 400 on agentId shows on the holder select; other 400 fields on theirs", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  server.use(
    http.put("*/api/v1/roles/:ns/:role", () =>
      HttpResponse.json(
        {
          error: {
            code: "bad_request",
            message: "That agent closed",
            details: { field: "agentId" },
          },
        },
        { status: 400 },
      ),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Add role" }));
  const dialog = await screen.findByRole("dialog");
  await pick(user, "Holder", /^opencode-1/);
  await user.type(within(dialog).getByLabelText("Role name"), "lane-7");
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  const holder = within(dialog).getByRole("combobox", { name: "Holder" });
  await waitFor(() =>
    expect(holder).toHaveAccessibleDescription("That agent closed"),
  );
  expect(holder).toHaveAttribute("aria-invalid", "true");
  expect(within(dialog).getByLabelText("Role name")).toHaveValue("lane-7");
  expect(within(dialog).getByLabelText("Role name")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );

  server.use(
    http.put("*/api/v1/roles/:ns/:role", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Hub unreachable" } },
        { status: 500 },
      ),
    ),
  );
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Hub unreachable",
  );
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("Re-point locks namespace and name, and offers the current holder", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  await user.click(screen.getByRole("button", { name: "Re-point lane-6" }));
  const dialog = await screen.findByRole("dialog", { name: "Re-point lane-6" });
  expect(
    within(dialog).getByRole("combobox", { name: "Namespace" }),
  ).toBeDisabled();
  expect(within(dialog).getByLabelText("Role name")).toHaveValue("lane-6");
  expect(within(dialog).getByLabelText("Role name")).toHaveAttribute(
    "readonly",
  );
  const holder = within(dialog).getByRole("combobox", { name: "Holder" });
  expect(holder).toHaveTextContent("claude-1");
  await user.click(holder);
  // The current holder is not "taken" by its own role.
  expect(screen.getByRole("option", { name: /^claude-1/ })).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await user.click(screen.getByRole("option", { name: /^opencode-1/ }));
  await user.click(within(dialog).getByRole("button", { name: "Save role" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(bus.roles().find((r) => r.role === "lane-6")?.agentId).toBe(
    OPENCODE.id,
  );
});

test("Remove confirms, the row goes at once, and a 404 counts as gone", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  await user.click(screen.getByRole("button", { name: "Remove lane-6" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm).toHaveTextContent("Remove lane-6?");
  await user.click(
    within(confirm).getByRole("button", { name: "Remove role" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("lane-6", { selector: "bdi[data-role]" }),
    ).not.toBeInTheDocument(),
  );
  expect(bus.roles().some((r) => r.role === "lane-6")).toBe(false);

  // Already gone on the server (another tab): its 404 is success, no error toast.
  await bus.removeRole(APP, "reviewer");
  await user.click(screen.getByRole("button", { name: "Remove reviewer" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove role",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("reviewer", { selector: "bdi[data-role]" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByText(/Couldn't remove/)).not.toBeInTheDocument();
});

test("a remove that fails brings the row back with a toast", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server.use(
    http.delete("*/api/v1/roles/:ns/:role", async () => {
      await gate;
      return HttpResponse.json(
        { error: { code: "internal", message: "Hub unreachable" } },
        { status: 500 },
      );
    }),
  );
  await user.click(screen.getByRole("button", { name: "Remove lane-6" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove role",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByText("lane-6", { selector: "bdi[data-role]" }),
    ).not.toBeInTheDocument(),
  );
  await act(async () => release());
  expect(
    await screen.findByText("lane-6", { selector: "bdi[data-role]" }),
  ).toBeInTheDocument();
  expect(await screen.findByText(/Couldn't remove/)).toHaveTextContent(
    "Couldn't remove lane-6",
  );
  expect(screen.getByText("Hub unreachable")).toBeInTheDocument();
});

test("a holder that closes reads Vacant after one feed frame, roles refetch, and Re-point still works", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("lane-6", { selector: "bdi[data-role]" });
  let gets = 0;
  server.use(
    http.get("*/api/v1/roles", () => {
      gets++;
      return HttpResponse.json({ roles: bus.roles() });
    }),
  );
  const rest = fixtures.agents.filter((a) => a.id !== CLAUDE.id);
  bus.setAgents(rest);
  push(bus.agents());
  await waitFor(() =>
    expect(within(rowOf("lane-6")).getByText("Vacant")).toBeInTheDocument(),
  );
  expect(rowOf("lane-6")).not.toHaveTextContent("claude-1");
  await waitFor(() => expect(gets).toBeGreaterThan(0));

  await user.click(screen.getByRole("button", { name: "Re-point lane-6" }));
  await pick(user, "Holder", /^opencode-1/);
  await user.click(screen.getByRole("button", { name: "Save role" }));
  await waitFor(() =>
    expect(rowOf("lane-6")).toHaveTextContent("lane-6 → opencode-1"),
  );
});

test("an agent row on Agents shows its role as a badge", async () => {
  mount("/agents");
  const name = await screen.findByText("claude-1", { selector: "bdi" });
  const row = name.closest("tr");
  if (!row) throw new Error("no claude-1 row");
  // Owner-set: a solid outline badge, read as "Role lane-6".
  const badge = row.querySelector("[data-slot=badge][data-variant=outline]");
  expect(badge).toHaveTextContent("Role lane-6");
  expect(within(row).getByText("Role")).toHaveClass("sr-only");
});
