import { toast } from "@ob/ui/shadcn";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { makeQueryClient } from "../src/api/queryClient";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { installHarness, server } from "./harness";
import { warmApp } from "./warm";

installHarness();
beforeAll(warmApp, 30_000);
afterEach(() => {
  toast.dismiss();
  vi.restoreAllMocks();
});

const AUD = "https://oa.example";
const PUNY = "https://xn--bcher-kva.example";
const PORT = "https://oa.example:8443";

const mount = (apps?: { aud: string; linkedAt: string }[]) => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  if (apps)
    server.use(
      http.get("*/api/v1/linked-apps", () => HttpResponse.json({ apps })),
    );
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider
        router={createAppRouter(
          createMemoryHistory({ initialEntries: ["/settings"] }),
        )}
      />
    </QueryClientProvider>,
  );
  return bus;
};

test("lists each aud as plain text with its link day, never a link", async () => {
  mount([
    { aud: PUNY, linkedAt: "2026-10-21T10:00:00.000Z" },
    { aud: PORT, linkedAt: "2026-10-22T10:00:00.000Z" },
  ]);
  expect(await screen.findByText(PUNY)).toBeInTheDocument();
  expect(screen.getByText(PORT)).toBeInTheDocument();
  expect(screen.getByText("Linked Oct 21, 2026")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Linked apps" }),
  ).toBeInTheDocument();
  const list = screen.getByText(PUNY).closest("section") as HTMLElement;
  expect(within(list).queryAllByRole("link")).toHaveLength(0);
  expect(list.querySelector("a")).toBeNull();
});

test("Settings is the last nav item, without a count", async () => {
  mount();
  const link = await screen.findByRole("link", {
    name: "Settings",
    hidden: true,
  });
  expect(link).toBeInTheDocument();
  const links = within(
    screen.getByRole("navigation", { name: "Main", hidden: true }),
  ).getAllByRole("link", { hidden: true });
  expect(links.at(-1)).toBe(link);
});

test("unlink confirms, then removes the row", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText(AUD);
  await user.click(screen.getByRole("button", { name: `Unlink ${AUD}` }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(`Unlink ${AUD}?`)).toBeInTheDocument();
  expect(
    within(dialog).getByText(
      `${AUD} can no longer verify your agents' cards. Cards it already has expire within 5 minutes.`,
    ),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "Unlink" }));
  await waitFor(() => expect(screen.queryByText(AUD)).not.toBeInTheDocument());
  expect(await screen.findByText(`Unlinked ${AUD}`)).toBeInTheDocument();
  expect(
    screen.getByText("No linked apps. Link one from the app's settings."),
  ).toBeInTheDocument();
});

test("an unlink that fails brings the row back with a toast", async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText(AUD);
  server.use(
    http.delete("*/api/v1/linked-apps/:aud", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Hub unreachable" } },
        { status: 500 },
      ),
    ),
  );
  await user.click(screen.getByRole("button", { name: `Unlink ${AUD}` }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Unlink",
    }),
  );
  expect(await screen.findByText(`Couldn't unlink ${AUD}`)).toBeInTheDocument();
  expect(screen.getByText("Hub unreachable")).toBeInTheDocument();
  expect(await screen.findByText(AUD)).toBeInTheDocument();
});

test("empty state when nothing is linked", async () => {
  mount([]);
  expect(
    await screen.findByText(
      "No linked apps. Link one from the app's settings.",
    ),
  ).toBeInTheDocument();
});
