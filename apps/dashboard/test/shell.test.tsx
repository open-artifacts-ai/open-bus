import { toast } from "@ob/ui/shadcn";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, expect, test } from "vitest";
import { qk } from "../src/api/qk";
import { makeQueryClient } from "../src/api/queryClient";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { FakeEventSource } from "./fakeEventSource";
import { installHarness, server } from "./harness";

installHarness();
// Sonner keeps active toasts module-wide and replays them to the next Toaster.
afterEach(() => toast.dismiss());

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
  expect(screen.getByRole("link", { name: /^Agents\b/ })).toHaveAttribute(
    "href",
    "/agents",
  );
  expect(screen.getByRole("link", { name: /^Machines\b/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: /^Agents\b/ })).not.toHaveAttribute(
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
  expect(screen.getByRole("link", { name: /^Agents\b/ })).toHaveAttribute(
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
  expect(screen.getByRole("link", { name: /^Machines\b/ })).toBeInTheDocument();
  await waitFor(() => expect(document.title).toBe("Not found · OpenBus"));
});

// ---- FE5 review round 1 ----

const signedIn = () => {
  server.use(...handlersFor(createMockBus()));
  const qc = makeQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={createAppRouter(createMemoryHistory({ initialEntries: ["/"] }))}
      />
    </QueryClientProvider>,
  );
  return qc;
};

for (const [name, reply] of [
  ["network error", () => HttpResponse.error()],
  [
    "500",
    () =>
      HttpResponse.json(
        { error: { code: "internal", message: "x" } },
        { status: 500 },
      ),
  ],
] as const) {
  test(`a /me refetch failure (${name}) keeps the signed-in shell and stream`, async () => {
    const qc = signedIn();
    await screen.findByRole("heading", { name: "Machines" });
    await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
    server.use(http.get("*/api/v1/me", reply));
    await act(async () => {
      await qc.refetchQueries({ queryKey: qk.me });
      // Let the query's batched notify reach React.
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(qc.getQueryState(qk.me)?.status).toBe("error");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Machines" }),
    ).toBeInTheDocument();
    expect(FakeEventSource.all[0]?.closed).toBe(false);
  });
}

test("a /me refetch 401 signs the owner out and closes the stream", async () => {
  const qc = signedIn();
  await screen.findByRole("heading", { name: "Machines" });
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  anonymous();
  await act(async () => {
    await qc.refetchQueries({ queryKey: qk.me });
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(
    await screen.findByRole("heading", { name: /sign in/i }),
  ).toBeInTheDocument();
  expect(FakeEventSource.all[0]?.closed).toBe(true);
});

test("a 401 on any API call mid-session signs the owner out and closes the stream", async () => {
  const qc = signedIn();
  await screen.findByRole("heading", { name: "Machines" });
  await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
  const es = FakeEventSource.all[0] as FakeEventSource;
  act(() => es.push({ type: "hello" }));
  server.use(
    http.get("*/api/v1/machines", () =>
      HttpResponse.json(
        { error: { code: "unauthorized", message: "Sign in" } },
        { status: 401 },
      ),
    ),
  );
  // The Machines page refetches its list (cancelling any GET still in flight).
  await act(async () => {
    await qc.invalidateQueries({ queryKey: qk.machines });
    await new Promise((r) => setTimeout(r, 50));
  });
  expect(
    await screen.findByRole("heading", { name: /sign in/i }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(es.closed).toBe(true);
  // A different owner on this tab never sees the previous one's data.
  expect(qc.getQueryData(qk.machines)).toBeUndefined();
  expect(qc.getQueryData(qk.agents)).toBeUndefined();
});

test("a signed-in owner visiting /sign-in lands on machines", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/sign-in");
  expect(
    await screen.findByRole("heading", { name: "Machines" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
});

for (const p of [
  "//evil.com",
  "/\\evil.com",
  "/%2F%2Fevil.com",
  "/auth/logout",
  "/api/v1/me",
]) {
  test(`the sign-in link never sends next off-site or into the Worker: ${p}`, async () => {
    anonymous();
    mount(p);
    const a = await screen.findByRole("link", { name: /continue/i });
    const next = new URL(
      a.getAttribute("href") as string,
      "https://bus.example",
    ).searchParams.get("next") as string;
    expect(new URL(next, "https://bus.example").origin).toBe(
      "https://bus.example",
    );
    expect(next).not.toMatch(/^\/(auth|api)(\/|$)/);
  });
}

test("the loading gate is a busy main landmark with a title", async () => {
  server.use(http.get("*/api/v1/me", () => new Promise<never>(() => {})));
  mount("/");
  const main = await screen.findByRole("main");
  expect(main).toHaveAttribute("aria-busy", "true");
  await waitFor(() => expect(document.title).toBe("Loading · OpenBus"));
});

test("navigating to Agents focuses its title in the header", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  fireEvent.click(screen.getByRole("link", { name: /^Agents\b/ }));
  const h1 = await screen.findByRole("heading", { level: 1, name: "Agents" });
  expect(
    within(screen.getByRole("banner")).getByRole("heading", { level: 1 }),
  ).toBe(h1);
  await waitFor(() => expect(document.activeElement).toBe(h1));
});

test("navigating to a page whose title sits in the header focuses that title", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/agents");
  await screen.findByRole("heading", { name: "Agents" });
  fireEvent.click(screen.getByRole("link", { name: /^Machines\b/ }));
  const h1 = await screen.findByRole("heading", { level: 1, name: "Machines" });
  await waitFor(() => expect(document.activeElement).toBe(h1));
});

test("the shell has one main landmark, holding the header and the page", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  const mains = screen.getAllByRole("main");
  expect(mains).toHaveLength(1);
  expect(mains[0]).toHaveAttribute("id", "ob-main");
  expect(
    within(mains[0] as HTMLElement).getByRole("heading", { level: 1 }),
  ).toBeInTheDocument();
});

test("Ctrl+B never collapses the desktop sidebar (there is no trigger to reopen it)", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  act(() => {
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  });
  const sidebar = document.querySelector('[data-slot="sidebar"]');
  expect(sidebar).toHaveAttribute("data-state", "expanded");
  expect(screen.getByRole("link", { name: /^Agents\b/ })).toBeInTheDocument();
});

test("/agents/ marks the Agents tab current", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/agents/");
  await screen.findByRole("heading", { name: "Agents" });
  expect(screen.getByRole("link", { name: /^Agents\b/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("link", { name: /^Machines\b/ })).not.toHaveAttribute(
    "aria-current",
  );
});

test("the sidebar shows the owner and a count per page", async () => {
  server.use(...handlersFor(createMockBus()));
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  const nav = screen.getByRole("navigation", { name: "Main" });
  // Machines counts every row in the table; Agents counts the roster. The
  // count is part of each link's name.
  expect(
    await within(nav).findByRole("link", { name: "Machines, 3" }),
  ).toBeInTheDocument();
  expect(
    await within(nav).findByRole("link", { name: "Agents, 3" }),
  ).toBeInTheDocument();
  expect(screen.getByText("ada@example.com")).toBeInTheDocument();
});

test("Sign out POSTs the logout with the CSRF header, then shows sign-in", async () => {
  const seen: Request[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server.use(
    http.post("*/auth/logout", async ({ request }) => {
      seen.push(request);
      await gate;
      return new HttpResponse(null, { status: 204 });
    }),
    ...handlersFor(createMockBus()),
  );
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  const button = screen.getByRole("button", { name: "Sign out" });
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  fireEvent.click(button);
  await act(async () => release());
  expect(
    await screen.findByRole("heading", { name: /sign in/i }),
  ).toBeInTheDocument();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.headers.get("X-OB-Request")).toBe("1");
});

test("a failed sign out toasts and stays signed in", async () => {
  server.use(
    http.post("*/auth/logout", () =>
      HttpResponse.json(
        { error: { code: "internal", message: "Hub unreachable" } },
        { status: 500 },
      ),
    ),
    ...handlersFor(createMockBus()),
  );
  mount("/");
  await screen.findByRole("heading", { name: "Machines" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Couldn't sign out")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("heading", { name: "Machines" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /sign in/i })).toBeNull();
});

test("below 768px the sidebar is a drawer the header opens", async () => {
  const width = window.innerWidth;
  window.innerWidth = 390;
  try {
    server.use(...handlersFor(createMockBus()));
    mount("/");
    await screen.findByRole("heading", { name: "Machines" });
    expect(screen.queryByRole("link", { name: /^Agents\b/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle navigation" }));
    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByRole("link", { name: /^Agents\b/ }),
    ).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("link", { name: /^Agents\b/ }));
    await screen.findByRole("heading", { name: "Agents" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    window.innerWidth = width;
  }
});

test("signing out drops the previous owner's cached data", async () => {
  const qc = signedIn();
  await screen.findByRole("heading", { name: "Machines" });
  await screen.findByText("studio-mbp");
  await waitFor(() => expect(qc.getQueryData(qk.agents)).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByRole("heading", { name: /sign in/i }),
  ).toBeInTheDocument();
  expect(qc.getQueryData(qk.machines)).toBeUndefined();
  expect(qc.getQueryData(qk.agents)).toBeUndefined();
  expect(qc.getQueryData(qk.me)).toBeNull();
});
