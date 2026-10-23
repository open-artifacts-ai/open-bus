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
import { afterEach, expect, test } from "vitest";
import type { Machine } from "../src/api/contract";
import { qk } from "../src/api/qk";
import type { MachinesData } from "../src/api/queries";
import { makeQueryClient } from "../src/api/queryClient";
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
const THINKPAD = fixtures.machines[1];
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

const rowOf = (label: string) => {
  const row = screen.getByText(label).closest("tr");
  if (!row) throw new Error(`no row for ${label}`);
  return row;
};

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

test("lists active and revoked machines in a table; only active ones can be revoked", async () => {
  mount();
  expect(await screen.findByText("studio-mbp")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();

  const studio = rowOf("studio-mbp");
  expect(within(studio).getByText(STUDIO.id)).toBeInTheDocument();
  expect(
    within(studio).getByRole("button", { name: "Revoke studio-mbp" }),
  ).toBeEnabled();
  expect(within(studio).queryByText("Revoked")).not.toBeInTheDocument();

  const thinkpad = rowOf("old-thinkpad");
  expect(within(thinkpad).getByText(THINKPAD.id)).toBeInTheDocument();
  expect(within(thinkpad).getByText("Revoked")).toBeInTheDocument();
  expect(within(thinkpad).getByText("old-thinkpad")).toHaveClass(
    "line-through",
  );
  expect(
    screen.queryByRole("button", { name: "Revoke old-thinkpad" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/1 is active/)).toBeInTheDocument();
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
  expect(within(dialog).getByText(/can't be undone/i)).toBeInTheDocument();
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
  expect(await screen.findByText("Machine revoked")).toBeInTheDocument();
  expect(screen.getByText("Its agents left the roster.")).toBeInTheDocument();
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
  expect(await screen.findByText("Machine revoked")).toBeInTheDocument();
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
  expect(screen.queryByText("Machine revoked")).not.toBeInTheDocument();
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
  const busy = await screen.findByLabelText("Loading machines");
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
  expect(
    await screen.findByText(/couldn't load your machines/i),
  ).toBeInTheDocument();
  expect(screen.queryByText(/no machines yet/i)).not.toBeInTheDocument();

  fail = false;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("studio-mbp")).toBeInTheDocument();
  expect(
    screen.queryByText(/couldn't load your machines/i),
  ).not.toBeInTheDocument();
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
  expect(await screen.findByText(/no machines yet/i)).toBeInTheDocument();
  expect(screen.getByText("npx open-bus")).toBeInTheDocument();
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

  expect(await screen.findByText("Machine revoked")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getAllByText("Machine revoked")).toHaveLength(1);
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
    expect(screen.queryByText("Machine revoked")).not.toBeInTheDocument();
  });
}

test("with every machine revoked the summary says none are active", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText("studio-mbp");
  await user.click(screen.getByRole("button", { name: "Revoke studio-mbp" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke machine",
    }),
  );
  expect(await screen.findByText(/None are active\./)).toBeInTheDocument();
});
