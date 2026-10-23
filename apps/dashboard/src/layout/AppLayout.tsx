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
  Toaster,
  useSidebar,
} from "@ob/ui/shadcn";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ApiClientError } from "../api/client";
import type { Me } from "../api/contract";
import { useMe } from "../api/queries";
import { LiveStatusProvider } from "../live/LiveStatus";
import { SignIn } from "../pages/SignIn";

/** Routes that render without the shell or the sign-in gate. */
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
      {BARE.has(path) ? <Outlet /> : <Gate path={path} />}
      <Toaster />
    </>
  );
}

/** Signed in: the shell and the one live stream. Otherwise: sign-in. */
function Gate({ path }: { path: string }) {
  const me = useMe();
  const search = useRouterState({ select: (s) => s.location.searchStr });

  if (me.isPending)
    return (
      <p role="status" className="p-6 text-muted-foreground">
        Loading…
      </p>
    );
  if (me.isError) {
    const unauthorized =
      me.error instanceof ApiClientError && me.error.status === 401;
    return <SignIn failed={!unauthorized} next={path + search} />;
  }
  return (
    <LiveStatusProvider>
      <Shell me={me.data} path={path} />
    </LiveStatusProvider>
  );
}

function Shell({ me, path }: { me: Me; path: string }) {
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
                  active={path === "/agents"}
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
