import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { makeQueryClient } from "../src/api/queryClient";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { createAppRouter } from "../src/router";
import { FakeWebSocket, installFakeWebSocket } from "./fakeWebSocket";
import { server } from "./harness";

/** Resolves when a <bdi> reading `text` is in the document (a DOM event, no polling). */
const appeared = (text: string) =>
  new Promise<void>((resolve) => {
    const hit = () =>
      [...document.querySelectorAll("bdi")].some((e) => e.textContent === text);
    if (hit()) return resolve();
    const mo = new MutationObserver(() => {
      if (!hit()) return;
      mo.disconnect();
      resolve();
    });
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

/**
 * A file's first render pays every cold cost at once (module evaluation, the
 * lazy route chunks, msw's and fetch's first request, the shell's first
 * layout). Under a loaded parallel run that alone outlasted findBy's 1 s, so
 * the first test of a file failed. Pay it here, in beforeAll, by rendering
 * each page once and waiting until its first row is in the DOM.
 */
export async function warmApp() {
  // beforeAll runs after server.listen swapped in msw's WebSocket.
  installFakeWebSocket();
  server.use(...handlersFor(createMockBus()));
  for (const [path, row] of [
    ["/", "studio-mbp"],
    ["/agents", "claude-1"],
  ] as const) {
    const view = render(
      <QueryClientProvider client={makeQueryClient()}>
        <RouterProvider
          router={createAppRouter(
            createMemoryHistory({ initialEntries: [path] }),
          )}
        />
      </QueryClientProvider>,
    );
    await act(() => appeared(row));
    view.unmount();
  }
  server.resetHandlers();
  FakeWebSocket.all = [];
}
