import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { Agents } from "./agents/Agents";
import { AppLayout } from "./layout/AppLayout";
import { Machines } from "./machines/Machines";
import { NotFound } from "./pages/NotFound";
import { SignIn } from "./pages/SignIn";

const root = createRootRoute({
  component: AppLayout,
  notFoundComponent: NotFound,
});

const signIn = createRoute({
  getParentRoute: () => root,
  path: "/sign-in",
  // `?error` (any value) means the Worker's callback failed.
  validateSearch: (s: Record<string, unknown>): { error?: string } =>
    "error" in s ? { error: String(s.error ?? "") } : {},
  component: function SignInRoute() {
    const { error } = signIn.useSearch();
    return <SignIn failed={error !== undefined} />;
  },
});

const routeTree = root.addChildren([
  createRoute({ getParentRoute: () => root, path: "/", component: Machines }),
  createRoute({
    getParentRoute: () => root,
    path: "/agents",
    component: Agents,
  }),
  signIn,
  createRoute({ getParentRoute: () => root, path: "*", component: NotFound }),
]);

export const createAppRouter = (history?: RouterHistory) =>
  createRouter({ routeTree, history });
export const router = createAppRouter();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
