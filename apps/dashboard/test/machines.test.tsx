import { toast } from "@ob/ui/shadcn";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, expect, test, vi } from "vitest";
import type { Machine } from "../src/api/contract";
import { qk } from "../src/api/qk";
import type { MachinesData } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
import { ago } from "../src/machines/MachineRow";
import { fixtures } from "../src/mocks/fixtures";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { FakeEventSource } from "./fakeEventSource";
import { installHarness, server } from "./harness";

installHarness();
// Sonner keeps active toasts module-wide and replays them to the next Toaster.
afterEach(() => toast.dismiss());

// Fixture ids and labels (src/mocks/fixtures.ts).
const STUDIO = fixtures.machines[0];
const THINKPAD = fixtures.machines[2];
if (STUDIO?.label !== "studio-mbp" || THINKPAD?.label !== "old-thinkpad")
  throw new Error("fixtures changed: update machines.test.tsx");

const ME = () => HttpResponse.json(fixtures.me);

/** Signed-in app at `/`, backed by a fresh mock bus. No retries, so errors show at once. */
const mount = (client: QueryClient = makeQueryClient()) => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      />
    </QueryClientProvider>,
  );
  return bus;
};

const revokedAt = (bus: ReturnType<typeof createMockBus>, id: string) =>
  bus.machines().find((m) => m.id === id)?.revokedAt;

/** The table row whose machine label is `label` (the label also shows in dialogs and toasts). */
const rowOf = (label: string) => {
  // hidden: a modal dialog hides the page from the accessibility tree.
  const row = screen
    .getAllByRole("row", { hidden: true })
    .find((r) => within(r).queryByText(label, { selector: "bdi" }));
  if (!row) throw new Error(`no row for ${label}`);
  return row;
};

/** The success toast's title: "<label> revoked", the label in mono. */
const revokedToast = (_: string, el: Element | null) =>
  el?.hasAttribute("data-title") === true &&
  el.textContent === "studio-mbp revoked";

/** "N machines · M live", read as one line. */
const summary = () =>
  screen.getByText(
    (_, el) =>
      el?.tagName === "P" && /\bmachines? ·/.test(el.textContent ?? ""),
  );

/** A DELETE that waits until the test releases it with a response. */
const heldDelete = () => {
  let release!: (r: Response) => void;
  const gate = new Promise<Response>((r) => {
    release = r;
  });
  server.use(http.delete("*/api/v1/machines/:id", () => gate));
  return (r: Response) => act(async () => release(r));
};

const boom = () =>
  HttpResponse.json(
    { error: { code: "internal", message: "Hub unreachable" } },
    { status: 500 },
  );

test("lists machines in a table with a status per row; only unrevoked ones can be revoked", async () => {
  mount();
  expect(await screen.findByText("studio-mbp")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
  for (const h of ["Machine", "Added", "Last used", "Status", "Actions"])
    expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();

  // Status comes from Machine.connected: connected is Live, else Offline.
  const studio = rowOf("studio-mbp");
  expect(
    within(studio).getByText(`${STUDIO.id.slice(0, 8)}…`),
  ).toBeInTheDocument();
  expect(within(studio).getByText("Live")).toBeInTheDocument();
  expect(studio.querySelector("[data-status]")).toHaveAttribute(
    "data-status",
    "live",
  );
  const travel = rowOf("laptop");
  expect(within(travel).getByText("Offline")).toBeInTheDocument();
  expect(travel.querySelector("[data-status]")).toHaveAttribute(
    "data-status",
    "offline",
  );
  // Phone-only prefixes are hidden from AT: the column headers label the cells.
  expect(within(studio).getByText("Added")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(within(studio).getByText("Last used")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(within(studio).getByText("Oct 21, 2026")).toBeInTheDocument();
  expect(
    within(studio).getByRole("button", { name: "Revoke studio-mbp" }),
  ).toBeEnabled();
  expect(
    within(studio).getByRole("button", { name: "More for studio-mbp" }),
  ).toBeInTheDocument();
  expect(within(studio).queryByText("Revoked")).not.toBeInTheDocument();

  const thinkpad = rowOf("old-thinkpad");
  expect(within(thinkpad).getByText("Revoked")).toBeInTheDocument();
  expect(thinkpad.querySelector("[data-status]")).toHaveAttribute(
    "data-status",
    "revoked",
  );
  expect(within(travel).getByText("Never")).toBeInTheDocument();
  expect(
    within(thinkpad).getByText("Revoked Oct 20, 2026"),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Revoke old-thinkpad" }),
  ).not.toBeInTheDocument();
  expect(summary()).toHaveTextContent("3 machines · 1 live");
});

test("a connected machine with no agents is Live, and the summary counts live rows", async () => {
  const bus = mount();
  bus.setMachines([
    ...fixtures.machines,
    {
      id: "MacMini3Hq8ZpLtv",
      label: "leo-mac-mini",
      createdAt: "2026-10-21T08:00:00.000Z",
      lastUsed: "2026-10-21T07:00:00.000Z",
      revokedAt: null,
      connected: true,
    },
  ]);
  await screen.findByText("leo-mac-mini");
  const mini = rowOf("leo-mac-mini");
  expect(within(mini).getByText("Live")).toBeInTheDocument();
  expect(
    within(mini).getByRole("button", { name: "Revoke leo-mac-mini" }),
  ).toBeEnabled();
  expect(summary()).toHaveTextContent("4 machines · 2 live");
  // laptop is approved but its daemon is away: Offline, not counted live.
  expect(within(rowOf("laptop")).getByText("Offline")).toBeInTheDocument();
});

test("the summary matches the table at once while a revoke is pending", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  const release = heldDelete();
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );
  await screen.findByRole("button", { name: "Revoking…" });
  // The pending overlay shows the row as Revoked, and the count agrees.
  expect(within(rowOf("studio-mbp")).getByText("Revoked")).toBeInTheDocument();
  expect(
    within(rowOf("studio-mbp")).queryByText("Live"),
  ).not.toBeInTheDocument();
  expect(summary()).toHaveTextContent("3 machines · 0 live");
  // Its agents leave the nav count at once too (laptop's queued one stays).
  expect(
    screen.getByRole("link", { name: "Agents, 1", hidden: true }),
  ).toBeInTheDocument();
  await release(new HttpResponse(null, { status: 204 }));
  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
});

test("a row's overflow menu copies the full machine id", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  mount();
  await screen.findByText("studio-mbp");
  // The keyboard path opens the same menu (Radix opens on pointerdown, not click).
  screen.getByRole("button", { name: "More for studio-mbp" }).focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", {
    name: "Actions for studio-mbp",
  });
  await user.click(
    within(menu).getByRole("menuitem", { name: "Copy machine id" }),
  );
  expect(writeText).toHaveBeenCalledWith(STUDIO.id);
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
});

test("the page header names the page and copies the install command", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  mount();
  const banner = await screen.findByRole("banner");
  expect(
    await within(banner).findByRole("heading", { level: 1, name: "Machines" }),
  ).toBeInTheDocument();
  await user.click(
    within(banner).getByRole("button", { name: "Copy npx open-bus" }),
  );
  expect(writeText).toHaveBeenCalledWith("npx open-bus");
  expect(screen.getByRole("note")).toHaveTextContent(
    /adding a machine: run npx open-bus/i,
  );
});

test("revoking asks first, names the machine, and Cancel changes nothing", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("studio-mbp");
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));

  const dialog = await screen.findByRole("alertdialog");
  expect(
    within(dialog).getByRole("heading", { name: /studio-mbp/ }),
  ).toBeInTheDocument();
  expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  // Focus never starts on the destructive button.
  expect(
    within(dialog).getByRole("button", { name: "Revoke machine" }),
  ).not.toHaveFocus();
  expect(revokedAt(bus, STUDIO.id)).toBeNull();

  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(revokedAt(bus, STUDIO.id)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Revoke studio-mbp" }),
  ).toHaveFocus();
});

test("confirming revokes, keeps the row as Revoked, and toasts", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("studio-mbp");
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );

  await waitFor(() => expect(revokedAt(bus, STUDIO.id)).not.toBeNull());
  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
  expect(
    screen.getByText("Its sockets closed and its agents left the roster."),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(
    screen.queryByRole("button", { name: "Revoke studio-mbp" }),
  ).not.toBeInTheDocument();
  expect(within(rowOf("studio-mbp")).getByText("Revoked")).toBeInTheDocument();
});

test("while the revoke is in flight the confirm reads Revoking… and both buttons are disabled", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  const release = heldDelete();
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke machine" }),
  );

  const confirm = await within(dialog).findByRole("button", {
    name: "Revoking…",
  });
  expect(confirm).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();

  await release(new HttpResponse(null, { status: 204 }));
  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
});

test("a failed revoke with the dialog open shows the error inline and no toast", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("studio-mbp");
  server.use(http.delete("*/api/v1/machines/:id", boom));
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(
    within(dialog).getByRole("button", { name: "Revoke machine" }),
  );

  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent(/couldn't revoke/i);
  expect(alert).toHaveTextContent("Hub unreachable");
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  expect(
    within(dialog).getByRole("button", { name: "Revoke machine" }),
  ).toBeEnabled();
  expect(screen.queryByText(revokedToast)).not.toBeInTheDocument();
  expect(screen.queryByText(/couldn't revoke studio-mbp/i)).toBe(alert);
  expect(revokedAt(bus, STUDIO.id)).toBeNull();

  // The pending overlay is gone: once closed, the row is revocable again.
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByRole("button", { name: "Revoke studio-mbp" }),
  ).toBeEnabled();
});

test("a revoke that fails after the dialog was closed raises a destructive toast", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  const release = heldDelete();
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );
  await screen.findByRole("button", { name: "Revoking…" });
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );

  await release(boom());
  expect(
    await screen.findByText("Couldn't revoke studio-mbp"),
  ).toBeInTheDocument();
  expect(screen.getByText("Hub unreachable")).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "Revoke studio-mbp" }),
  ).toBeEnabled();
});

test("loading shows a busy skeleton, not an empty state", async () => {
  server.use(
    http.get("*/api/v1/me", ME),
    http.get("*/api/v1/machines", () => new Promise<Response>(() => {})),
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      />
    </QueryClientProvider>,
  );
  const busy = await screen.findByRole("table", { name: "Loading machines" });
  expect(busy).toHaveAttribute("aria-busy", "true");
  expect(busy.querySelector("[data-slot=skeleton]")).not.toBeNull();
  expect(screen.queryByText(/no machines yet/i)).not.toBeInTheDocument();
});

test("a failed list shows a retry that recovers, not an empty page", async () => {
  const user = userEvent.setup();
  let fail = true;
  const bus = createMockBus();
  // The first matching handler wins, so the override goes first.
  server.use(
    http.get("*/api/v1/machines", () =>
      fail
        ? HttpResponse.json(
            { error: { code: "internal", message: "Boom" } },
            { status: 500 },
          )
        : HttpResponse.json({ machines: bus.machines() }),
    ),
    ...handlersFor(bus),
  );
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      />
    </QueryClientProvider>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/couldn't load machines/i);
  expect(alert).toHaveTextContent(/nothing changed/i);
  expect(screen.queryByText(/no machines yet/i)).not.toBeInTheDocument();

  fail = false;
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("studio-mbp")).toBeInTheDocument();
  expect(screen.queryByText(/couldn't load machines/i)).not.toBeInTheDocument();
});

test("no machines yet shows the install command", async () => {
  server.use(
    http.get("*/api/v1/me", ME),
    http.get("*/api/v1/machines", () => HttpResponse.json({ machines: [] })),
  );
  render(
    <QueryClientProvider client={makeQueryClient()}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: /no machines yet/i }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Copy command" }),
  ).toBeInTheDocument();
  expect(screen.getByText("No machines")).toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

test("a dead stream pauses live updates but never empties the list", async () => {
  mount();
  await screen.findByText("studio-mbp");
  const source = FakeEventSource.all.at(-1);
  if (!source) throw new Error("the shell opened no stream");
  act(() => source.fail());

  expect(await screen.findByRole("status")).toHaveTextContent(
    /live updates paused/i,
  );
  expect(screen.getByText("studio-mbp")).toBeInTheDocument();
  expect(screen.getByText("old-thinkpad")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Revoke studio-mbp" }),
  ).toBeEnabled();
});

test("while paused the Live/Offline badges are muted and keep their words", async () => {
  mount();
  await screen.findByText("studio-mbp");
  const live = rowOf("studio-mbp").querySelector("[data-status]");
  const off = rowOf("laptop").querySelector("[data-status]");
  expect(live).not.toHaveAttribute("data-muted");
  const source = FakeEventSource.all.at(-1);
  if (!source) throw new Error("the shell opened no stream");
  act(() => source.fail());
  await waitFor(() => expect(live).toHaveAttribute("data-muted", "true"));
  expect(off).toHaveAttribute("data-muted", "true");
  // Token colour, never opacity (opacity-60 puts the Live badge at ~2.4:1).
  for (const b of [live, off]) {
    expect(b).toHaveClass("text-muted-foreground");
    expect(b?.className).not.toMatch(/opacity/);
    // tailwind-merge dropped the badge's own colour, so nothing competes.
    expect(b?.className).not.toMatch(/ob-success-fg|text-secondary-foreground/);
  }
  expect(live).toHaveTextContent("Live");
  expect(off).toHaveTextContent("Offline");
  // A revoke is a fact the owner confirmed, not a liveness claim.
  expect(
    rowOf("old-thinkpad").querySelector("[data-status]"),
  ).not.toHaveAttribute("data-muted");
});

test("a stream machines frame that disconnects studio-mbp flips its badge and the live count", async () => {
  mount();
  await screen.findByText("studio-mbp");
  expect(summary()).toHaveTextContent("3 machines · 1 live");
  const source = FakeEventSource.all.at(-1);
  if (!source) throw new Error("the shell opened no stream");
  act(() =>
    source.push({
      type: "machines",
      machines: fixtures.machines.map((m) =>
        m.label === "studio-mbp" ? { ...m, connected: false } : m,
      ),
    }),
  );
  await waitFor(() =>
    expect(
      within(rowOf("studio-mbp")).getByText("Offline"),
    ).toBeInTheDocument(),
  );
  expect(summary()).toHaveTextContent("3 machines · 0 live");
});

test("while paused the live count is muted like the badges", async () => {
  mount();
  await screen.findByText("studio-mbp");
  expect(summary().querySelector("[data-muted]")).toBeNull();
  const source = FakeEventSource.all.at(-1);
  if (!source) throw new Error("the shell opened no stream");
  act(() => source.fail());
  await waitFor(() =>
    expect(summary().querySelector("[data-muted]")).not.toBeNull(),
  );
  expect(summary()).toHaveTextContent("3 machines · 1 live");
});

test("the paused status region is mounted empty first, so the change is announced", async () => {
  mount();
  await screen.findByText("studio-mbp");
  const region = screen.getByRole("status");
  expect(region).toBeEmptyDOMElement();
  const source = FakeEventSource.all.at(-1);
  if (!source) throw new Error("the shell opened no stream");
  act(() => source.fail());
  await waitFor(() => expect(region).toHaveTextContent(/live updates paused/i));
  expect(screen.getByRole("status")).toBe(region);
});

test("a synchronous double confirm revokes once and toasts once", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  const confirm = within(await screen.findByRole("alertdialog")).getByRole(
    "button",
    { name: "Revoke machine" },
  );
  let deletes = 0;
  server.events.on("request:start", ({ request }) => {
    if (request.method === "DELETE") deletes++;
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getAllByText(revokedToast)).toHaveLength(1);
  expect(deletes).toBe(1);
  server.events.removeAllListeners();
});

for (const [name, change] of [
  ["removes", (ms: Machine[]) => ms.filter((m) => m.id !== STUDIO.id)],
  [
    "revokes",
    (ms: Machine[]) =>
      ms.map((m) =>
        m.id === STUDIO.id
          ? { ...m, revokedAt: "2026-10-22T10:00:00.000Z" }
          : m,
      ),
  ],
] as const) {
  test(`a snapshot that ${name} the dialog's machine closes the dialog without a toast`, async () => {
    const user = userEvent.setup();
    const qc = makeQueryClient();
    mount(qc);
    await screen.findByText("studio-mbp");
    await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
    await screen.findByRole("alertdialog");

    act(() => {
      qc.setQueryData<MachinesData>(qk.machines, (old) =>
        old ? { machines: change(old.machines) } : old,
      );
    });
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(revokedToast)).not.toBeInTheDocument();
  });
}

test("with every machine revoked the summary says 0 live", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  for (const label of ["studio-mbp", "laptop"]) {
    await user.click(
      await screen.findByRole("button", { name: `Revoke ${label}` }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke machine",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
  }
  await waitFor(() =>
    expect(summary()).toHaveTextContent("3 machines · 0 live"),
  );
});

test("our own pending revoke shows the row as Revoked but keeps the dialog open on Revoking…", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  const release = heldDelete();
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );

  // The overlay marks the target revoked…
  await waitFor(() =>
    expect(
      within(rowOf("studio-mbp")).getByText("Revoked"),
    ).toBeInTheDocument(),
  );
  // …and the stale-target close must not fire for it.
  await new Promise((r) => setTimeout(r, 50));
  const dialog = screen.getByRole("alertdialog");
  expect(
    within(dialog).getByRole("button", { name: "Revoking…" }),
  ).toBeDisabled();
  expect(screen.queryByText(revokedToast)).not.toBeInTheDocument();

  await release(new HttpResponse(null, { status: 204 }));
  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
});

test("after a 204 the dialog waits for the refetch, then closes with one toast", async () => {
  const user = userEvent.setup();
  const bus = mount();
  await screen.findByText("studio-mbp");

  // Once the DELETE has gone through, hold the next machines GET.
  let deleted = false;
  let releaseGet!: () => void;
  const getGate = new Promise<void>((r) => {
    releaseGet = r;
  });
  server.use(
    http.delete("*/api/v1/machines/:id", async ({ params }) => {
      const res = await bus.revoke(String(params.id));
      deleted = true;
      return res;
    }),
    http.get("*/api/v1/machines", async () => {
      if (deleted) await getGate;
      return HttpResponse.json({ machines: bus.machines() });
    }),
  );

  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );
  await waitFor(() => expect(deleted).toBe(true));
  await new Promise((r) => setTimeout(r, 50));

  // DELETE done, refetch held: still pending, no toast, no stale close.
  expect(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Revoking…",
    }),
  ).toBeDisabled();
  expect(screen.queryByText(revokedToast)).not.toBeInTheDocument();

  await act(async () => releaseGet());
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  expect(await screen.findByText(revokedToast)).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getAllByText(revokedToast)).toHaveLength(1);
});

test("ago rounds into the next unit instead of reading 60 min or 24 h", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const before = (secs: number) => new Date(now - secs * 1000).toISOString();
  expect(ago(before(30), now)).toBe("just now");
  expect(ago(before(120), now)).toBe("2 min ago");
  expect(ago(before(59 * 60), now)).toBe("59 min ago");
  expect(ago(before(3570), now)).toBe("1 h ago");
  expect(ago(before(3 * 3600), now)).toBe("3 h ago");
  expect(ago(before(23.6 * 3600), now)).toBe("1 d ago");
  expect(ago(before(2 * 86400), now)).toBe("2 d ago");
  expect(ago(before(6.6 * 86400), now)).toBe("Oct 16, 2026");
  expect(ago("nope", now)).toBe("Unknown");
});
