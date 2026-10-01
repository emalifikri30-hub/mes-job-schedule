import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { DateGrid, MAX_ROWS_PER_CELL } from "@/components/calendar/date-grid";

import type { ShiftBlock } from "@/lib/types";

// THE MONTH GRID. These assert the ARRANGEMENT — the weekday header, where the
// date sits, how a shift block is drawn, and what happens to the overflow.

const TZ = "Asia/Jakarta";

let seq = 0;
// Shift 1: 07:00 – 15:00 Jakarta, which is 00:00Z – 08:00Z.
function occ(overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  seq += 1;
  return {
    jobId: seq,
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

// Reset BEFORE each test, not inside setup(): the blocks are built as setup's
// arguments, so a reset in there would run after they had already been
// numbered by whatever ran before.
beforeEach(() => {
  seq = 0;
});

function setup(occurrences: ShiftBlock[] = [], onOpenDate = vi.fn()) {
  return {
    onOpenDate,
    ...renderWithQuery(
      <DateGrid
        mode="month"
        from="2026-09-01"
        occurrences={occurrences}
        timeZone={TZ}
        onOpenDate={onOpenDate}
      />,
    ),
  };
}

describe("the grid itself", () => {
  it("heads the columns SUN through SAT", () => {
    setup();

    for (const name of ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("always draws 42 day cells, so the grid never changes height", () => {
    setup();

    // A grid that grows with the month makes the page jump as you page through
    // the year.
    expect(screen.getAllByRole("button", { name: /^Open \d{4}-\d{2}-\d{2}$/ })).toHaveLength(42);
  });

  it("names the MONTH on its first day", () => {
    // "Sep 1" rather than "1", which is how a reader tells where the leading and
    // trailing days belong without counting back.
    setup();

    expect(screen.getByRole("button", { name: "Open 2026-09-01" }).textContent).toBe("Sep 1");
    expect(screen.getByRole("button", { name: "Open 2026-09-02" }).textContent).toBe("2");
  });

  it("includes the neighbouring months' days rather than blanking them", () => {
    // 2026-09-01 is a Tuesday, so a Sunday-start grid opens on 30 August.
    setup();

    expect(screen.getByRole("button", { name: "Open 2026-08-30" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open 2026-10-10" })).toBeTruthy();
  });
});

describe("how a shift block is drawn", () => {
  it("shows its START time plus the shift and line count", () => {
    // Compact, and the start only: a cell row has one line for both, so the full
    // range would eat the label.
    setup([occ()]);

    const block = screen.getByRole("note", { name: /Job #1/ });
    expect(block.textContent).toContain("7am");
    expect(block.textContent).toContain("S1 · 1 line");
    // NOT the end time — that is in the tooltip and in the day and week views.
    expect(block.textContent).not.toContain("3pm");
  });

  it("carries the full range, the lines and the counts in the tooltip", () => {
    // Nothing the compact row drops is unreachable — just not always on screen.
    setup([occ()]);

    const title = screen.getByRole("note", { name: /Job #1/ }).getAttribute("title");
    expect(title).toContain("07:00 – 15:00");
    expect(title).toContain("Line A");
    expect(title).toContain("2 machines");
  });

  it("orders a day's blocks by the clock, S1 before S3", () => {
    setup([
      occ({ shift: 3, startsAt: "2026-09-21T16:00:00.000Z", endsAt: "2026-09-22T00:00:00.000Z" }),
      occ({ shift: 1 }),
    ]);

    const blocks = screen.getAllByRole("note");
    expect(blocks[0]!.textContent).toContain("S1");
    expect(blocks[1]!.textContent).toContain("S3");
  });

  it("puts Friday's S3 in FRIDAY's cell — the business date — not Saturday's", () => {
    setup([
      occ({
        occurrenceDate: "2026-09-25",
        shift: 3,
        startsAt: "2026-09-25T16:00:00.000Z",
        endsAt: "2026-09-26T00:00:00.000Z",
      }),
    ]);

    const friday = screen.getByRole("button", { name: "Open 2026-09-25" }).parentElement;
    const saturday = screen.getByRole("button", { name: "Open 2026-09-26" }).parentElement;
    expect(within(friday as HTMLElement).queryByRole("note")).not.toBeNull();
    expect(within(saturday as HTMLElement).queryByRole("note")).toBeNull();
  });

  it("is not a button — detail is disabled", () => {
    setup([occ()]);

    expect(screen.queryByRole("button", { name: /Job #1/ })).toBeNull();
  });
});

describe("overflow", () => {
  const many = Array.from({ length: MAX_ROWS_PER_CELL + 2 }, () => occ());

  it("caps the rows in a cell and offers the rest", () => {
    // A cell that grows with its content makes every row in the grid a different
    // height, and one busy day turns the other five weeks into whitespace.
    setup(many);

    expect(screen.getAllByRole("note")).toHaveLength(MAX_ROWS_PER_CELL);
    expect(screen.getByText("2 more")).toBeTruthy();
  });

  it("drops into the day when the overflow is clicked", async () => {
    const onOpenDate = vi.fn();
    setup(many, onOpenDate);

    await userEvent.click(screen.getByText("2 more"));

    expect(onOpenDate).toHaveBeenCalledWith("2026-09-21");
  });

  it("offers no overflow control when everything fits", () => {
    setup([occ()]);

    expect(screen.queryByText(/more$/)).toBeNull();
  });
});

describe("the date cell", () => {
  it("drops into the day view when clicked", async () => {
    const onOpenDate = vi.fn();
    setup([], onOpenDate);

    await userEvent.click(screen.getByRole("button", { name: "Open 2026-09-15" }));

    expect(onOpenDate).toHaveBeenCalledWith("2026-09-15");
  });

  it("keeps each day's blocks in their own cell", () => {
    setup([
      occ({ occurrenceDate: "2026-09-21" }),
      occ({
        occurrenceDate: "2026-09-22",
        startsAt: "2026-09-22T00:00:00.000Z",
        endsAt: "2026-09-22T08:00:00.000Z",
      }),
    ]);

    const cell = screen.getByRole("button", { name: "Open 2026-09-21" }).parentElement;
    expect(within(cell as HTMLElement).getByRole("note", { name: /Job #1/ })).toBeTruthy();
    expect(within(cell as HTMLElement).queryByRole("note", { name: /Job #2/ })).toBeNull();
  });
});
