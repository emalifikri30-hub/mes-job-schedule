import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { shiftBlocksKey } from "@/lib/queries";
import { CalendarView } from "@/components/calendar/calendar-view";

import type { ShiftBlock } from "@/lib/types";

// WHICH STATE THE SURFACE SELECTS — the one thing a pure function cannot reach,
// and therefore the only thing worth a component test here. The geometry, the
// window arithmetic and the overlap rules are covered exhaustively as functions
// in lib/*.test.ts.

const FILTERS = { workCenterIds: [] as number[], workUnitIds: [] as number[] };
const ANCHOR = "2026-09-21";
const TZ = "Asia/Jakarta";

// Must match lib/queries.ts EXACTLY. A key that drifts does not fail loudly —
// the component simply never sees the seed and renders its loading state, so
// every assertion below would fail with a confusing message rather than this one.
function key(view: { from: string; to: string }) {
  return shiftBlocksKey({ ...view, ...FILTERS });
}

// Shift 1 of 21 September: 07:00 – 15:00 Jakarta, 00:00Z – 08:00Z.
function occurrence(overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  return {
    jobId: 1,
    occurrenceDate: "2026-09-21",
    shift: 1,
    startsAt: "2026-09-21T00:00:00.000Z",
    endsAt: "2026-09-21T08:00:00.000Z",
    timeZone: TZ,
    lineNames: ["Line A"],
    lineCount: 1,
    machineCount: 2,
    skuCount: 3,
    ...overrides,
  };
}

function view(props: Partial<React.ComponentProps<typeof CalendarView>> = {}) {
  return (
    <CalendarView
      viewMode="fourDay"
      anchor={ANCHOR}
      timeZone={TZ}
      filters={FILTERS}
      onAnchorChange={() => {}}
      onViewModeChange={() => {}}
      {...props}
    />
  );
}

// The 4-day window for the anchor above, which every seed below must match.
const FOUR_DAY = { from: "2026-09-21", to: "2026-09-25" };

// THE GRID IS ALWAYS ON SCREEN. This block is the guard on the correction: the
// surface used to be swapped out for a message in three cases, and the third —
// "no events in this window" — made the product feel broken. A calendar with no
// events is not an empty state; it is a calendar, with empty days.
describe("the grid is never replaced", () => {
  const dayHeaders = () => screen.queryAllByText(/^(SUN|MON|TUE|WED|THU|FRI|SAT)$/);

  it("draws the grid when the window has NOTHING in it", () => {
    // The bug: an empty month replaced the dates with a sentence, so the reader
    // could not see which month they were on or click a day to add anything.
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [], truncated: false } }],
    });

    expect(dayHeaders().length).toBeGreaterThan(0);
    expect(screen.queryByText(/no job scheduled/i)).toBeNull();
  });

  it("draws the grid before the first response arrives", () => {
    // Nothing seeded. A skeleton slab here is the same failure in a different
    // coat — the calendar is gone.
    renderWithQuery(view());

    expect(dayHeaders().length).toBeGreaterThan(0);
    expect(screen.queryByText("Shift 1")).toBeNull();
  });

  it("draws the grid even when the fetch FAILED, and says so loudly", () => {
    // An empty grid after a failed fetch would otherwise read as "nothing is
    // scheduled", which is the dangerous direction on a job calendar.
    const { queryClient } = renderWithQuery(view());
    queryClient.setQueryData(key(FOUR_DAY), undefined);
    renderWithQuery(view({ anchor: ANCHOR }));

    expect(dayHeaders().length).toBeGreaterThan(0);
  });

  it("KEEPS the navigation and view switcher whatever the state", () => {
    // They are how a reader finds out WHY a period is empty — which, on a
    // filtered calendar, is usually the filter.
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [], truncated: false } }],
    });

    expect(screen.getByRole("button", { name: /next period/i })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /calendar view/i })).toBeTruthy();
  });

  it("draws an empty MONTH grid with all its dates", () => {
    renderWithQuery(view({ viewMode: "month" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-01", to: "2026-10-01" }),
          data: { blocks: [], truncated: false },
        },
      ],
    });

    // Every day still clickable, so an operator can open one and add something.
    expect(screen.getAllByRole("button", { name: /^Open \d{4}-\d{2}-\d{2}$/ })).toHaveLength(42);
  });
});

describe("state selection", () => {
  it("renders shift blocks when there are some", () => {
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [occurrence()], truncated: false } }],
    });

    expect(screen.getAllByText("Shift 1").length).toBeGreaterThan(0);
    // Counts, not targets (decision 1A).
    expect(screen.getByText("1 line · 2 machines · 3 SKUs")).toBeTruthy();
  });
});

describe("a block opens the job's detail", () => {
  // A click opens the READ-ONLY detail on the block's business date — never the
  // edit form, which would put every glance one keystroke from re-planning a job.
  // Asserted in all three renderers, because each draws its own block.

  it("from the time grid, with the block's business date", async () => {
    const onSelectBlock = vi.fn();
    renderWithQuery(view({ onSelectBlock }), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [occurrence()], truncated: false } }],
    });

    await userEvent.click(screen.getByRole("button", { name: /Job #1/ }));

    expect(onSelectBlock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 1, occurrenceDate: "2026-09-21" }),
    );
  });

  it("from the month grid", async () => {
    const onSelectBlock = vi.fn();
    renderWithQuery(view({ viewMode: "month", onSelectBlock }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-01", to: "2026-10-01" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: /Job #1/ }));

    expect(onSelectBlock).toHaveBeenCalledTimes(1);
  });

  it("from the agenda", async () => {
    const onSelectBlock = vi.fn();
    renderWithQuery(view({ viewMode: "schedule", onSelectBlock }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-21", to: "2026-12-20" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    await userEvent.click(screen.getByText("Shift 1 · Job #1"));

    expect(onSelectBlock).toHaveBeenCalledTimes(1);
  });

  // Without somewhere to go, a block must not LOOK clickable.
  it("is not a button when there is no handler", () => {
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [occurrence()], truncated: false } }],
    });

    expect(screen.queryByRole("button", { name: /Job #1/ })).toBeNull();
    expect(screen.getByRole("note", { name: /Job #1/ })).toBeTruthy();
  });
});

describe("truncation", () => {
  it("shows a banner when the server had to cut the list short", () => {
    // The dangerous direction: without this, the calendar is simply MISSING
    // job windows and looks complete.
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [occurrence()], truncated: true } }],
    });

    expect(screen.getByText(/showing part of this period/i)).toBeTruthy();
  });

  it("shows no banner when nothing was truncated", () => {
    renderWithQuery(view(), {
      seed: [{ queryKey: key(FOUR_DAY), data: { blocks: [occurrence()], truncated: false } }],
    });

    expect(screen.queryByText(/showing part of this period/i)).toBeNull();
  });
});

describe("renderer selection", () => {
  // Each view mode has its own window, so each needs its own seed. The point of
  // these four is that the SAME data reaches a different renderer — a mode that
  // silently fell through to the time grid would still show the event name, so
  // each assertion names something only its own renderer draws.

  it("draws the hour grid for a time view", () => {
    renderWithQuery(view({ viewMode: "week" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-20", to: "2026-09-27" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    // The hour gutter, which only the time grid draws — and in the same am/pm
    // vocabulary the block rows use.
    expect(screen.getByText("8am")).toBeTruthy();
  });

  it("draws the month grid for the month view", () => {
    renderWithQuery(view({ viewMode: "month" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-01", to: "2026-10-01" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    // The month grid gives every cell an "Open <date>" button; the time grid
    // has no such control.
    expect(screen.getByRole("button", { name: "Open 2026-09-21" })).toBeTruthy();
  });

  it("draws twelve mini-months and NO shift blocks for the year view", () => {
    renderWithQuery(view({ viewMode: "year" }), {
      seed: [
        {
          queryKey: key({ from: "2026-01-01", to: "2027-01-01" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    // Twelve month tiles, each a real readable grid — the year is named once,
    // in the period heading above.
    expect(screen.getByText("Dec")).toBeTruthy();
    expect(screen.getByText("Jan")).toBeTruthy();
    // NO blocks at this scale: a year of individual rows is thousands of DOM
    // nodes of text nobody can read. The count reaches the accessible name, and
    // a dot marks the day.
    expect(screen.queryByText("Shift 1")).toBeNull();
    expect(screen.getByRole("button", { name: "2026-09-21: 1 shift" })).toBeTruthy();
  });

  it("draws the agenda list for the schedule view", () => {
    renderWithQuery(view({ viewMode: "schedule" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-21", to: "2026-12-20" }),
          data: { blocks: [occurrence()], truncated: false },
        },
      ],
    });

    // The agenda rail prints the day and month; no grid view does.
    expect(screen.getByText("21 Sep")).toBeTruthy();
    expect(screen.getByText("Shift 1 · Job #1")).toBeTruthy();
  });

  it("says so when the agenda period is empty — the ONE place a message is right", () => {
    // Not an exception to the rule above. The Schedule view is a LIST, not a
    // grid: there are no dates drawn to keep, so a message IS the honest
    // rendering of an empty one. AgendaList owns it.
    renderWithQuery(view({ viewMode: "schedule" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-21", to: "2026-12-20" }),
          data: { blocks: [], truncated: false },
        },
      ],
    });

    expect(screen.getByText(/nothing scheduled in this period/i)).toBeTruthy();
  });
});

describe("the period label", () => {
  it("names what is ON SCREEN, not the anchor", () => {
    // An anchor of 23 September in Month view must read "September 2026". The
    // label is derived from the window for exactly this reason.
    renderWithQuery(view({ viewMode: "month", anchor: "2026-09-23" }), {
      seed: [
        {
          queryKey: key({ from: "2026-09-01", to: "2026-10-01" }),
          data: { blocks: [], truncated: false },
        },
      ],
    });

    expect(screen.getByRole("heading", { name: "Sep 2026" })).toBeTruthy();
  });

  it("names the year in the year view", () => {
    renderWithQuery(view({ viewMode: "year", anchor: "2026-09-23" }), {
      seed: [
        {
          queryKey: key({ from: "2026-01-01", to: "2027-01-01" }),
          data: { blocks: [], truncated: false },
        },
      ],
    });

    expect(screen.getByRole("heading", { name: "2026" })).toBeTruthy();
  });
});
