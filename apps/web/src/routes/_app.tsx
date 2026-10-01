import { Outlet, createFileRoute } from "@tanstack/react-router";

import { requireAuth } from "@/lib/auth-guard";
import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AreaProvider } from "@/components/layout/area-context";
import { CalendarChromeProvider } from "@/components/layout/calendar-chrome";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pathless layout route (the `_` prefix contributes no URL segment) holding the
// authenticated app shell. Two jobs, both of which it does exactly once for every
// page underneath it:
//
//   1. `beforeLoad: requireAuth` gates the whole subtree. Because it runs before
//      the component mounts, an unauthenticated visitor never renders a frame of
//      protected UI — no loader flash, no chrome around an empty page. That is
//      why there is no <RequireAuth> wrapper component here.
//   2. Its `{ me }` return merges into the router context, so child routes read
//      `Route.useRouteContext().me` instead of each calling useMe().
//
// /login is a sibling of this route, not a child, so it stays reachable and
// renders without the sidebar.
export const Route = createFileRoute("/_app")({
  beforeLoad: requireAuth,
  component: AppLayout,
});

function AppLayout() {
  return (
    // AreaProvider wraps the header (which sets the area), the sidebar and the
    // outlet (which scope their line lists to it), so it sits above all three.
    <TooltipProvider delayDuration={0}>
      <AreaProvider>
        <SidebarProvider>
          {/* CalendarChromeProvider is INSIDE SidebarProvider and wraps both the
            sidebar and the outlet: the sidebar's buttons open the dialogs, the
            calendar page opens the edit one, and there is exactly one of each on
            the page. See its header for the full picture. */}
          <CalendarChromeProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader />
              {/* p-0 at the bottom edge: the calendar is the page, and a gutter
                under it just shortens the grid. */}
              <main className="min-w-0 flex-1 p-4 md:p-6">
                <Outlet />
              </main>
            </SidebarInset>
          </CalendarChromeProvider>
        </SidebarProvider>
      </AreaProvider>
    </TooltipProvider>
  );
}
