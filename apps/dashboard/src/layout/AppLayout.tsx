import {
  Sidebar,
  SidebarBrand,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  Skeleton,
  Toaster,
  useSidebar,
} from "@ob/ui/shadcn";
import {
  Link,
  Navigate,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { ApiClientError } from "../api/client";
import type { Me } from "../api/contract";
import { useMe } from "../api/queries";
import { LiveStatusProvider } from "../live/LiveStatus";
import { SignIn } from "../pages/SignIn";
import { useDocumentTitle } from "./useDocumentTitle";

/** Routes that render without the shell; a signed-in owner is sent home. */
const BARE = new Set(["/sign-in"]);

const icon = (d: string) => (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);
const ICONS = {
  machines: icon("M2.5 3h11v7.5h-11zM6 13.5h4M8 10.5v3"),
  agents: icon(
    "M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4",
  ),
};

/** The app's one Toaster sits beside every layout. */
export function AppLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <Gate path={path} />
      <Toaster />
    </>
  );
}

/**
 * Signed in: the shell and the one live stream. Data wins over a failed
 * refetch, so only a 401 (me → null, see makeQueryClient) signs the owner out.
 */
function Gate({ path }: { path: string }) {
  const me = useMe();
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const bare = BARE.has(path);

  if (me.data)
    return bare ? (
      <Navigate to="/" replace />
    ) : (
      <LiveStatusProvider>
        <Shell me={me.data} path={path} />
      </LiveStatusProvider>
    );
  if (me.isPending) return <Loading />;
  if (bare) return <Outlet />;
  const failed =
    me.isError &&
    !(me.error instanceof ApiClientError && me.error.code === "unauthorized");
  return <SignIn failed={failed} next={path + search} />;
}

function Loading() {
  useDocumentTitle("Loading");
  return (
    <main aria-busy="true" className="mx-auto max-w-[880px] p-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-7 w-40" />
      <Skeleton className="mt-6 h-24 w-full" />
    </main>
  );
}

function Shell({ me, path }: { me: Me; path: string }) {
  // On navigation (not first paint), move focus to the content so screen
  // readers and keyboard users start at the new page.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per page
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    document.getElementById("ob-main")?.focus({ preventScroll: true });
  }, [path]);
  return (
    <SidebarProvider>
      <a
        href="#ob-main"
        className="sr-only z-60 rounded-sm bg-card px-2 py-1 text-foreground shadow-(--ob-shadow-2) focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Nav path={path} />
      <SidebarInset>
        <header className="sticky top-0 z-5 flex h-12 flex-none items-center gap-2.5 border-b bg-background px-5 max-md:px-3 md:rounded-t-[calc(var(--radius-lg)-1px)]">
          <SidebarTrigger aria-label="Toggle navigation" />
          <span className="ml-auto truncate text-muted-foreground">
            {me.user.email}
          </span>
        </header>
        <main
          id="ob-main"
          tabIndex={-1}
          className="min-w-0 flex-1 p-6 outline-none max-sm:p-4"
        >
          <div className="mx-auto max-w-[880px]">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function NavLink({
  to,
  active,
  icon,
  children,
}: {
  to: "/" | "/agents";
  active: boolean;
  icon: ReactNode;
  children: string;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link
          to={to}
          aria-current={active ? "page" : undefined}
          activeProps={{}}
          onClick={() => setOpenMobile(false)}
        >
          {icon}
          <span>{children}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Nav({ path }: { path: string }) {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar variant="inset">
      <SidebarHeader
        className="h-12 justify-center gap-0 p-0 in-data-[mobile=true]:mx-2 in-data-[mobile=true]:mt-2"
        onClick={(e) => {
          // SidebarBrand is a plain <a>: route it client-side.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
          if (!(e.target as Element).closest("a")) return;
          e.preventDefault();
          setOpenMobile(false);
          void navigate({ to: "/" });
        }}
      >
        <SidebarBrand href="/" />
      </SidebarHeader>
      <SidebarContent className="in-data-[mobile=true]:px-2">
        <nav aria-label="Main">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavLink to="/" active={path === "/"} icon={ICONS.machines}>
                  Machines
                </NavLink>
                <NavLink
                  to="/agents"
                  active={path === "/agents" || path.startsWith("/agents/")}
                  icon={ICONS.agents}
                >
                  Agents
                </NavLink>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
