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
  toast,
  useSidebar,
} from "@ob/ui/shadcn";
import { useQueryClient } from "@tanstack/react-query";
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
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiClientError, api } from "../api/client";
import { AUTH, type Me } from "../api/contract";
import { qk } from "../api/qk";
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
  // On navigation (not first paint), move focus to the new page so screen
  // readers and keyboard users start there. Keyed on the resolved location,
  // so the new page (and its header title) has rendered.
  const shown = useRouterState({
    select: (s) => s.resolvedLocation?.pathname,
  });
  const first = useRef(true);
  useEffect(() => {
    if (shown === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    // The page's title when it can take focus (PageHeader's h1), else the region.
    const title = document.querySelector<HTMLElement>(
      '#ob-main h1[tabindex="-1"]',
    );
    (title ?? document.getElementById("ob-main"))?.focus({
      preventScroll: true,
    });
  }, [shown]);
  // Pages put their title and actions here (PageHeader).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    // Always open at md and up: the trigger is md:hidden, so a collapse (the
    // Ctrl/Cmd+B shortcut) could not be undone. Below md it is the drawer.
    <SidebarProvider open onOpenChange={() => {}}>
      <a
        href="#ob-main"
        className="sr-only z-60 rounded-sm bg-card px-2 py-1 text-foreground shadow-(--ob-shadow-2) focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <Nav me={me} path={path} />
      {/* One main landmark: SidebarInset is the <main>; the header is in it. */}
      <SidebarInset id="ob-main" tabIndex={-1} className="min-w-0 outline-none">
        <header className="sticky top-0 z-5 flex h-14 shrink-0 items-center gap-2 border-b bg-(--ob-chrome) px-4">
          <SidebarTrigger
            aria-label="Toggle navigation"
            className="md:hidden"
          />
          <div ref={setSlot} className="contents" />
        </header>
        <div className="mx-auto w-full max-w-[960px] min-w-0 flex-1 px-4 pt-6 pb-6 md:px-8">
          <HeaderSlotContext.Provider value={slot}>
            <Outlet />
          </HeaderSlotContext.Provider>
        </div>
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
          {/* The count is part of the link's name ("Machines, 2"); the badge is visual. */}
          {count !== undefined && <span className="sr-only">, {count}</span>}
        </Link>
      </SidebarMenuButton>
      {count !== undefined && (
        <SidebarMenuBadge aria-hidden="true">{count}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function Nav({ me, path }: { me: Me; path: string }) {
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  // Machines counts every row of its table; Agents counts the roster listed,
  // minus agents on machines with a revoke pending (they are leaving).
  const machineList = useMachines().data?.machines;
  const agentList = useAgents().data?.agents;
  const machines = machineList?.length;
  const agents = useMemo(() => {
    if (!agentList) return undefined;
    const gone = new Set(
      machineList?.filter((m) => m.revokedAt !== null).map((m) => m.id),
    );
    return agentList.filter((a) => !gone.has(a.machineId)).length;
  }, [agentList, machineList]);
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
          <SignOut />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * POST /auth/logout (204, no redirect; GET is 404). On success `me` becomes
 * null and the gate renders sign-in; on failure the owner stays signed in.
 */
function SignOut() {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const signOut = () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    api.send("POST", AUTH.logout).then(
      () => qc.setQueryData(qk.me, null),
      (e: unknown) => {
        // Already signed out: same end state.
        if (e instanceof ApiClientError && e.code === "unauthorized") {
          qc.setQueryData(qk.me, null);
          return;
        }
        busy.current = false;
        setPending(false);
        toast.error("Couldn't sign out", {
          description:
            e instanceof Error && e.message
              ? e.message
              : "Something went wrong.",
          duration: 8000,
        });
      },
    );
  };
  return (
    <Button
      variant="link"
      size="xs"
      className="ml-auto px-0 text-muted-foreground"
      disabled={pending}
      onClick={signOut}
    >
      Sign out
    </Button>
  );
}
