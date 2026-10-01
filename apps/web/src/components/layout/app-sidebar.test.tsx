import { describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { AreaProvider } from "@/components/layout/area-context";
import { CalendarChromeProvider } from "@/components/layout/calendar-chrome";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

// THE SIDEBAR IS THE LAYOUT CHANGE, so this asserts the arrangement the mock
// specifies rather than any one control's behaviour: the app switcher, Create
// Job, the date-range calendar, then a divider, then Log Activity, then the
// footer user menu — plus the mobile-only block that keeps the header's
// filters and area picker reachable on a phone.
//
// It renders the REAL CalendarChromeProvider rather than stubbing the context,
// because the thing most likely to break here is the wiring — a button that
// opens nothing looks perfectly fine in a screenshot.

const setSearch = vi.fn();

vi.mock("@/lib/calendar-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/calendar-search")>();
  return {
    ...actual,
    useCalendarSearch: () => ({
      tab: "calendar" as const,
      view: "fourDay" as const,
      anchor: "2026-09-21",
      range: undefined,
      lines: [],
      machines: [],
      page: 1,
      size: 10,
      hasFilters: false,
      setSearch,
    }),
  };
});

const AREAS = [{ id: 1, code: "AJINE-MASAKO", name: "Ajine Masako" }];

function setup() {
  setSearch.mockClear();
  return renderWithQuery(
    <AreaProvider>
      <SidebarProvider>
        <CalendarChromeProvider>
          <AppSidebar />
        </CalendarChromeProvider>
      </SidebarProvider>
    </AreaProvider>,
    {
      seed: [
        { queryKey: ["areas"], data: AREAS },
        { queryKey: ["work-centers", 1], data: [] },
        { queryKey: ["me"], data: { sub: "kc-1", preferredUsername: "superadmin", email: "s@x" } },
        // The Create Job dialog's three people pickers, seeded so opening it
        // never reaches for the network.
        { queryKey: ["role-users", "MANAGER"], data: [] },
        { queryKey: ["role-users", "FOREMAN"], data: [] },
        { queryKey: ["role-users", "AFA"], data: [] },
      ],
    },
  );
}

describe("the panel's contents", () => {
  it("carries the app switcher", () => {
    setup();

    expect(screen.getByRole("button", { name: /job schedule/i })).toBeTruthy();
  });

  it("keeps the user menu reachable", () => {
    setup();

    expect(screen.getByRole("button", { name: /superadmin/i })).toBeTruthy();
  });

  it("carries the two actions, and NO Recurring Events", () => {
    // Recurrence was removed with the maintenance event model.
    setup();

    expect(screen.getByRole("button", { name: "Create Job" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Log Activity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /recurring/i })).toBeNull();
  });

  it("carries the mini calendar as the DATE RANGE the tabs read", async () => {
    setup();

    // September 2026, because the mocked anchor is the 21st.
    expect(screen.getByText(/Sep 2026/)).toBeTruthy();
    expect(screen.getByText(/no date range/i)).toBeTruthy();

    // The first click is a one-day range, written at once.
    await userEvent.click(screen.getByRole("button", { name: "2026-09-15" }));
    expect(setSearch).toHaveBeenCalledWith({ from: "2026-09-15", to: "2026-09-15" });
  });
});

describe("the actions are wired to the overlays", () => {
  // CREATE JOB SHIPPED, and this asserts the button is genuinely ENABLED and
  // wired — it spent the module's first release disabled (TODOS.md §0), and a
  // `disabled` left behind by a partial revert would look like a permission
  // problem rather than a bug.
  it("Create Job is enabled and opens the job dialog", async () => {
    setup();

    const create = screen.getByRole("button", { name: "Create Job" });
    expect((create as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(create);

    expect(await screen.findByRole("heading", { name: "Create job" })).toBeTruthy();
  });

  it("Log Activity opens the audit trail", async () => {
    setup();

    await userEvent.click(screen.getByRole("button", { name: "Log Activity" }));

    expect(await screen.findByText(/every change to a job/i)).toBeTruthy();
  });
});

describe("the mobile section", () => {
  // Below `md` the header cannot hold four controls, so they are RELOCATED here
  // rather than hidden. Hiding and relocating look identical in markup and are
  // opposite decisions — the previous layout hid the area picker with nowhere
  // else to reach it, which made it unavailable on a phone rather than moved.
  it("keeps the area picker reachable", () => {
    setup();

    expect(screen.getByRole("combobox", { name: "Area" })).toBeTruthy();
  });

  it("keeps the line and machine pickers reachable", () => {
    setup();

    expect(screen.getByRole("combobox", { name: /filter by line/i })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /filter by machine/i })).toBeTruthy();
  });

  it("is the one that hides on desktop, not the controls themselves", () => {
    // The guard on the decision above: this block must be md:hidden, and the
    // header's copy must be hidden md:flex. If both were hidden at some width,
    // the control would be unreachable and nothing else would say so.
    const { container } = setup();
    const mobile = container.querySelector(".md\\:hidden");

    expect(mobile).not.toBeNull();
    expect(within(mobile as HTMLElement).getByRole("combobox", { name: "Area" })).toBeTruthy();
  });
});
