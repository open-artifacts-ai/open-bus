import {
  Avatar,
  AvatarFallback,
  Button,
  Sidebar,
  SidebarBrand,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
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
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { ApiClientError } from "../api/client";
import { AUTH, type Me } from "../api/contract";
import { useAgents, useMachines, useMe } from "../api/queries";
import { LiveStatusProvider } from "../live/LiveStatus";
import { SignIn } from "../pages/SignIn";
import { LaptopIcon, RadioIcon } from "./icons";
import { hue, initials } from "./identity";
import { HeaderSlotContext } from "./PageHeader";
import { useDocumentTitle } from "./useDocumentTitle";

/** Routes that render without the shell; a signed-in owner is sent home. */
const BARE = new Set(["/sign-in"]);

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
  // Pages put their title and actions here (PageHeader).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <SidebarProvider>
      <a
        href="#ob-main"
        className="sr-only z-60 rounded-sm bg-card px-2 py-1 text-foreground shadow-(--ob-shadow-2) focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Nav me={me} path={path} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-5 flex h-14 shrink-0 items-center gap-2 border-b bg-(--ob-chrome) px-4">
          <SidebarTrigger
            aria-label="Toggle navigation"
            className="md:hidden"
          />
          <div ref={setSlot} className="contents" />
        </header>
        <main
          id="ob-main"
          tabIndex={-1}
          className="min-w-0 flex-1 outline-none"
        >
          <div className="mx-auto w-full max-w-[960px] px-4 pt-6 pb-6 md:px-8">
            <HeaderSlotContext.Provider value={slot}>
              <Outlet />
            </HeaderSlotContext.Provider>
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
  count,
  children,
}: {
  to: "/" | "/agents";
  active: boolean;
  icon: ReactNode;
  count: number | undefined;
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
      {count !== undefined && <SidebarMenuBadge>{count}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
}

function Nav({ me, path }: { me: Me; path: string }) {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  // Machines counts every row of its table; Agents counts the roster.
  const machines = useMachines().data?.machines.length;
  const agents = useAgents().data?.agents.length;
  const who = me.user.name ?? me.user.email;
  return (
    <Sidebar>
      <SidebarHeader
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
      <SidebarContent>
        <nav aria-label="Main">
          <SidebarGroup>
            <SidebarMenu>
              <NavLink
                to="/"
                active={path === "/"}
                icon={<LaptopIcon />}
                count={machines}
              >
                Machines
              </NavLink>
              <NavLink
                to="/agents"
                active={path === "/agents" || path.startsWith("/agents/")}
                icon={<RadioIcon />}
                count={agents}
              >
                Agents
              </NavLink>
            </SidebarMenu>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      {/* One owner per deployment: no workspace switcher, just who is signed in. */}
      <SidebarFooter>
        <div className="flex min-w-0 items-center gap-2 rounded-md p-2">
          <Avatar
            size="sm"
            aria-hidden="true"
            style={{ "--hue": hue(me.user.id) } as CSSProperties}
          >
            <AvatarFallback className="bg-[hsl(var(--hue)_45%_30%)] font-semibold text-white">
              {initials(who.split("@")[0] ?? who)}
            </AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 leading-tight">
            {me.user.name && (
              <bdi className="truncate text-sm font-medium">{me.user.name}</bdi>
            )}
            <bdi className="truncate text-xs text-muted-foreground">
              {me.user.email}
            </bdi>
          </div>
          <Button
            asChild
            variant="link"
            size="xs"
            className="ml-auto px-0 text-muted-foreground"
          >
            <a href={AUTH.logout}>Sign out</a>
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
