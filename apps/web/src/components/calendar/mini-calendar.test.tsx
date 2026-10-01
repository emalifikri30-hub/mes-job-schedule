import { describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { MiniCalendar } from "@/components/calendar/mini-calendar";

// THE CORRECTION THIS FILE GUARDS: the mini calendar is a DATE PICKER, and the
// view switcher must not reach it.
//
// It used to take the view mode and highlight every date the main grid was
// showing — so switching the body to Year lit up all 365 days in the sidebar and
// buried the one thing the control is for.

const TZ = "Asia/Jakarta";

function setup(selected = "2026-09-21") {
  const onPick = vi.fn();
  return {
    onPick,
    ...renderWithQuery(<MiniCalendar selected={selected} timeZone={TZ} onPick={onPick} />),
  };
}

describe("it takes no view mode", () => {
  it("marks exactly ONE date as current, whatever the body is showing", () => {
    // The regression: a range of highlighted days instead of a selection.
    setup();

    expect(screen.getAllByRole("button", { current: "date" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "2026-09-21", current: "date" })).toBeTruthy();
  });

  it("does not accept a viewMode prop at all", () => {
    // The strongest guard available in TypeScript is the absence of the prop;
    // this asserts the runtime consequence — the component renders one month,
    // not a window.
    setup();

    expect(screen.getByText(/Sep 2026/)).toBeTruthy();
  });
});

describe("browsing is independent of the selection", () => {
  it("pages months without picking anything", async () => {
    // Looking at November must not move the main calendar — only a CLICK does.
    const { onPick } = setup();

    await userEvent.click(screen.getByRole("button", { name: /next month/i }));

    expect(screen.getByText(/Oct 2026/)).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("pages backwards too", async () => {
    setup();

    await userEvent.click(screen.getByRole("button", { name: /previous month/i }));

    expect(screen.getByText(/Aug 2026/)).toBeTruthy();
  });

  it("follows the selection when it changes from OUTSIDE", () => {
    // Pressing Today, or clicking a date in the main grid, must bring the picker
    // with it — otherwise it sits on a month unrelated to what is on screen.
    const { rerender } = setup("2026-09-21");
    expect(screen.getByText(/Sep 2026/)).toBeTruthy();

    rerender(<MiniCalendar selected="2026-12-05" timeZone={TZ} onPick={() => {}} />);

    expect(screen.getByText(/Dec 2026/)).toBeTruthy();
  });
});

describe("picking a date", () => {
  it("reports the date it was clicked on", async () => {
    const { onPick } = setup();

    await userEvent.click(screen.getByRole("button", { name: "2026-09-15" }));

    expect(onPick).toHaveBeenCalledWith("2026-09-15");
  });

  it("can pick a day from a neighbouring month", async () => {
    // Those cells are drawn, so they must work — a date you can see and cannot
    // click is worse than one that is not there.
    const { onPick } = setup();

    await userEvent.click(screen.getByRole("button", { name: "2026-08-30" }));

    expect(onPick).toHaveBeenCalledWith("2026-08-30");
  });
});

describe("range mode — the sidebar's date range", () => {
  function setupRange(range?: { from: string; to: string }) {
    const onRangePick = vi.fn();
    return {
      onRangePick,
      ...renderWithQuery(
        <MiniCalendar
          mode="range"
          range={range}
          fallback="2026-09-21"
          timeZone={TZ}
          onRangePick={onRangePick}
        />,
      ),
    };
  }

  it("writes a one-day range on the FIRST click, so the page follows at once", async () => {
    const { onRangePick } = setupRange();

    await userEvent.click(screen.getByRole("button", { name: "2026-09-23" }));

    expect(onRangePick).toHaveBeenLastCalledWith({ from: "2026-09-23", to: "2026-09-23" });
  });

  it("closes the range on the second click, in either order", async () => {
    const { onRangePick } = setupRange();

    await userEvent.click(screen.getByRole("button", { name: "2026-09-25" }));
    await userEvent.click(screen.getByRole("button", { name: "2026-09-23" }));

    expect(onRangePick).toHaveBeenLastCalledWith({ from: "2026-09-23", to: "2026-09-25" });
  });

  it("extends from the range's start on a SHIFT-click", async () => {
    const { onRangePick } = setupRange({ from: "2026-09-10", to: "2026-09-12" });
    // ONE user instance, so the held Shift is still held at the click —
    // separate `userEvent.*` calls each start with no keys down.
    const user = userEvent.setup();

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "2026-09-20" }));
    await user.keyboard("{/Shift}");

    expect(onRangePick).toHaveBeenLastCalledWith({ from: "2026-09-10", to: "2026-09-20" });
  });

  it("marks the two ENDS as current and tints the days between", () => {
    setupRange({ from: "2026-09-10", to: "2026-09-12" });

    expect(screen.getAllByRole("button", { current: "date" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "2026-09-11", pressed: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2026-09-13", pressed: false })).toBeTruthy();
  });

  it("opens on the fallback month and highlights nothing when no range is picked", () => {
    setupRange();

    expect(screen.getByText(/Sep 2026/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { current: "date" })).toHaveLength(0);
  });
});
