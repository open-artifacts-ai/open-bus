// Must run before any schema parses: see ./zod.ts.
import "./zod";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { makeQueryClient } from "./api/queryClient";
import { router } from "./router";
// Order matters: the tokens (and their font @import) first, then Tailwind + theme.
import "./styles.css";
import "./shadcn.css";

async function boot() {
  // Dev/e2e only: Vite replaces the flag at build time, so the branch and the
  // dynamic import are dropped from production bundles.
  if (import.meta.env.VITE_MOCK === "1") {
    const { startMocks } = await import("./mocks/browser");
    await startMocks();
  }
  // biome-ignore lint/style/noNonNullAssertion: index.html always has #root
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={makeQueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
void boot();
