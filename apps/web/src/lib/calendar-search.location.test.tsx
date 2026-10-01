import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { useCalendarSearch, validateCalendarSearch } from "@/lib/calendar-search";

// THE BUG THIS FILE EXISTS FOR, and it is the reason it uses a REAL router
// instead of the mocked hook the component tests use.
//
// `useCalendarSearch` used to call `useSearch({ strict: false })`, which resolves
// against the CLOSEST MATCH. The sidebar and the header are rendered by `_app`,
// which has no `validateSearch` of its own — so the closest match's search was an
// empty object and every control mounted above the route read `{}`.
//
// It looked like it worked. The route itself owns the search contract and got
// real values, so the calendar behaved; only the chrome was blind, and only when
// the URL carried something. The visible symptom was the mini calendar sitting
// on today's month while the body was on another year.
//
// Every component test in this repo mocks `useCalendarSearch`, so none of them
// could see it. This one renders the hook against an actual location.

function Probe() {
  const { tab, view, anchor, range, lines, machines, page, hasFilters } = useCalendarSearch();
  return (
    <dl>
      <dd data-testid="tab">{tab}</dd>
      <dd data-testid="view">{view}</dd>
      <dd data-testid="anchor">{anchor}</dd>
      <dd data-testid="range">{range === undefined ? "none" : `${range.from}..${range.to}`}</dd>
      <dd data-testid="lines">{lines.join(",")}</dd>
      <dd data-testid="machines">{machines.join(",")}</dd>
      <dd data-testid="page">{page}</dd>
      <dd data-testid="hasFilters">{String(hasFilters)}</dd>
    </dl>
  );
}

// A layout route with NO validateSearch, wrapping the calendar route that has
// one — the exact shape of the real tree, because the shape is what broke.
function renderAt(url: string) {
  const rootRoute = createRootRoute();
  const layoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "_app",
    // Deliberately absent, as in routes/_app.tsx.
  });
  const calendarRoute = createRoute({
    getParentRoute: () => layoutRoute,
    path: "/calendar",
    validateSearch: validateCalendarSearch,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([layoutRoute.addChildren([calendarRoute])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });

  // Rendered OUTSIDE the route's own component, the way the sidebar and header
  // are — which is the whole point of the test.
  return render(
    <RouterContextProvider router={router as never}>
      <Probe />
    </RouterContextProvider>,
  );
}

const read = (key: string) => screen.getByTestId(key).textContent;

describe("a control mounted ABOVE the route still sees the URL", () => {
  it("reads the anchor date", () => {
    renderAt("/calendar?date=2026-12-05");

    expect(read("anchor")).toBe("2026-12-05");
  });

  it("reads the view mode", () => {
    renderAt("/calendar?view=year");

    expect(read("view")).toBe("year");
  });

  it("reads the tab", () => {
    renderAt("/calendar?tab=gantt");

    expect(read("tab")).toBe("gantt");
  });

  it("reads the filters", () => {
    renderAt("/calendar?lines=10,11&machines=100&page=3");

    expect(read("lines")).toBe("10,11");
    expect(read("machines")).toBe("100");
    expect(read("page")).toBe("3");
    expect(read("hasFilters")).toBe("true");
  });

  it("anchors the calendar on the range's start when nothing was paged", () => {
    // Decision 2A: the sidebar range drives Table and Gantt, and on the
    // Calendar tab its start is where the calendar opens.
    renderAt("/calendar?from=2026-09-23&to=2026-09-25");

    expect(read("range")).toBe("2026-09-23..2026-09-25");
    expect(read("anchor")).toBe("2026-09-23");
  });

  it("lets a paged anchor win over the range's start", () => {
    renderAt("/calendar?from=2026-09-23&to=2026-09-25&date=2026-10-07");

    expect(read("anchor")).toBe("2026-10-07");
  });

  it("applies the defaults when the URL carries nothing", () => {
    renderAt("/calendar");

    expect(read("tab")).toBe("calendar");
    expect(read("view")).toBe("fourDay");
    expect(read("range")).toBe("none");
    expect(read("page")).toBe("1");
    expect(read("hasFilters")).toBe("false");
    // The anchor falls back to the plant's today, which is a real date.
    expect(read("anchor")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("validates the URL rather than trusting it", () => {
    // The same parser the route uses: a machine with no line is meaningless, and
    // an unreal date is dropped rather than fed to `new Date()`.
    renderAt("/calendar?date=2026-02-30&machines=100");

    expect(read("machines")).toBe("");
    expect(read("anchor")).not.toBe("2026-02-30");
  });
});
