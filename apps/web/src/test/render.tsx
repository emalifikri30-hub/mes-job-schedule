import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";

import { i18n, registerMessages } from "@/lib/i18n";
import en from "@/lib/locales/en.json";
import id from "@/lib/locales/id.json";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

import type { ReactElement, ReactNode } from "react";

registerMessages("jobs", { en, id });

// The wrapper every component test needs, in one place.
//
// Every fetching component subscribes through TanStack Query, so rendering one
// bare throws "No QueryClient set". Repeating the provider per test file
// would also repeat the two options below, and getting either wrong is what
// makes a component suite flaky rather than failing:
//
//   retry: false        — otherwise an error-state test waits out three retries
//                         with exponential backoff before the assertion can run,
//                         and looks like a timeout rather than a failure.
//   staleTime: Infinity — nothing refetches mid-assertion, so a test observes
//                         the state it seeded and no other.
//
// A FRESH client per call, never a module-level one: a shared cache would let a
// test that seeds "loaded" leak into the next test's "empty" assertion, in file
// order, which is the hardest kind of suite failure to read.
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      // Mutations are a SEPARATE defaults bucket — the `queries` options above do
      // not reach them. v5 already defaults mutations to no retry, so this is
      // explicitness rather than a fix: an error-state test must observe the
      // first failure, not the third.
      mutations: { retry: false },
    },
  });
}

// Seed the cache with what a query would have returned, so a test can render a
// component in its populated state without a network layer. `queryKey` must match the
// options in lib/queries.ts exactly — that coupling is the point, since a key
// that drifts is a component that silently refetches forever.
type Seed = { queryKey: readonly unknown[]; data: unknown };

// The paths components <Link> to, as stub routes.
//
// A component rendered bare throws "useRouter must be used inside a
// RouterProvider" the moment it contains a Link — and TanStack resolves `to`
// against the route tree it was given, so a path missing here produces an href
// of "/" rather than an error, which a test asserting navigation would happily
// pass.
//
// STUBS RATHER THAN THE REAL TREE from routeTree.gen.ts: mounting that renders
// the whole app shell around the one component under test, which is the opposite
// of what these tests are for. The cost is that this list has to be extended
// when something links somewhere new; the CI freshness check on routeTree.gen.ts
// does not cover it, so a wrong href shows up as a failing assertion in the
// component's own test, which is where it belongs.
//
// This module has ONE screen, so the list is short. It is kept as a list rather
// than inlined because the failure it guards against — a silent href="/" — does
// not get easier to spot as the app grows.
const LINK_PATHS = ["/calendar"] as const;

// A memory router carrying just enough route tree for Link to resolve `to`.
//
// Paired with RouterContextProvider, NOT RouterProvider. That distinction is the
// whole reason this works: RouterProvider renders the ACTIVE MATCH and resolves
// it asynchronously, so every card would appear one tick after render and every
// existing synchronous `getBy*` assertion in this suite would start failing as a
// "not found". RouterContextProvider only places the router in context and
// renders its children directly, which is exactly the amount of router a card
// containing a Link needs.
//
// Rebuilt per render for the reason the QueryClient is: shared router state
// would let one test leak into the next.
function createTestRouter() {
  const rootRoute = createRootRoute();

  const stubs = LINK_PATHS.map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null }),
  );

  return createRouter({
    routeTree: rootRoute.addChildren(stubs),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

// Return type inferred, not annotated: `ReturnType<typeof render>` resolves
// through @testing-library/react's own bundled @testing-library/dom types, which
// are a different copy from the one this workspace hoists, so spelling it out
// makes the two disagree over `debug`'s signature.
function renderWithQuery(ui: ReactElement, { seed = [] }: { seed?: Seed[] } = {}) {
  const queryClient = createTestQueryClient();

  for (const { queryKey, data } of seed) {
    queryClient.setQueryData(queryKey, data);
  }

  // Mirrors the providers a component actually renders under. In the app the
  // tooltip context comes from SidebarProvider, several levels above anything
  // (components/ui/sidebar.tsx), so a component rendered on its own throws
  // "`Tooltip` must be used within `TooltipProvider`" — as a caught React error
  // that leaves the test green and a stack trace in the output. Supplying it
  // here is the difference between a suite that passes and one that means
  // something.
  //
  // AreaProvider is NOT supplied here. A component that reads the header's area
  // picker needs it, and needing it is a fact worth stating at the call site —
  // so those few tests wrap it themselves rather than every test paying for a
  // context most do not touch.
  function Wrapper({ children }: { children: ReactNode }) {
    const router = createTestRouter();

    return (
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <TooltipProvider>
            {/* Save and delete toasts are asserted in the dialog and drawer tests,
              and sonner renders nothing at all without a Toaster mounted. */}
            <Toaster />
            {/* Cast: the module augmentation in router.ts registers the APP's
              route tree globally, so the provider's props are typed against that
              tree rather than this stub one. The runtime contract — a router
              that can resolve the paths above — is what the cards need. */}
            <RouterContextProvider router={router as never}>{children}</RouterContextProvider>
          </TooltipProvider>
        </I18nextProvider>
      </QueryClientProvider>
    );
  }

  return { ...render(ui, { wrapper: Wrapper }), queryClient };
}

export { createTestQueryClient, renderWithQuery };
export type { Seed };
