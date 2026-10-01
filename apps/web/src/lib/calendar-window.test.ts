import { describe, expect, it } from "vite-plus/test";

import { diffDays } from "@/lib/civil-date";
import {
  GANTT_DEFAULT_DAYS,
  GANTT_MAX_DAYS,
  SCHEDULE_SPAN_DAYS,
  calendarWindow,
  ganttWindow,
  rangeWindow,
  monthGridDays,
  shiftAnchor,
  yearMonths,
} from "@/lib/calendar-window";

import type { CalendarViewMode } from "@/lib/types";

const ALL_MODES: CalendarViewMode[] = ["day", "fourDay", "week", "month", "year", "schedule"];

describe("calendarWindow — invariants that hold for every view", () => {
  for (const mode of ALL_MODES) {
    it(`${mode}: days run from..to-1, and "to" is exclusive`, () => {
      const w = calendarWindow(mode, "2026-09-23");
      expect(w.days[0]).toBe(w.from);
      expect(w.days).toHaveLength(diffDays(w.from, w.to));
      expect(w.days).not.toContain(w.to);
      // No gaps: consecutive entries are exactly one day apart.
      for (let i = 1; i < w.days.length; i += 1) {
        expect(diffDays(w.days[i - 1]!, w.days[i]!)).toBe(1);
      }
    });

    it(`${mode}: stays inside the server's 400-day cap`, () => {
      // A view that asks for more than the API accepts is a screen that can only
      // ever render an error, so the cap is asserted here rather than discovered
      // in a 400. A leap year is the widest case.
      const w = calendarWindow(mode, "2028-01-01");
      expect(diffDays(w.from, w.to)).toBeLessThanOrEqual(400);
    });
  }
});

describe("calendarWindow — spans", () => {
  it("day is one day and starts at the anchor", () => {
    expect(calendarWindow("day", "2026-09-23")).toMatchObject({
      from: "2026-09-23",
      to: "2026-09-24",
    });
  });

  it("fourDay is four days FROM the anchor, not snapped to a week", () => {
    // Snapping would move the page under a user who just clicked Wednesday.
    const w = calendarWindow("fourDay", "2026-09-23");
    expect(w.from).toBe("2026-09-23");
    expect(w.days).toEqual(["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
  });

  it("week snaps back to Sunday and spans seven", () => {
    const w = calendarWindow("week", "2026-09-23");
    expect(w.from).toBe("2026-09-20");
    expect(w.to).toBe("2026-09-27");
  });

  it("week honours a Monday start", () => {
    expect(calendarWindow("week", "2026-09-23", 1).from).toBe("2026-09-21");
  });

  it("month snaps to the 1st and spans the real month length", () => {
    expect(calendarWindow("month", "2026-09-23")).toMatchObject({
      from: "2026-09-01",
      to: "2026-10-01",
    });
    expect(calendarWindow("month", "2026-02-10").days).toHaveLength(28);
    expect(calendarWindow("month", "2028-02-10").days).toHaveLength(29);
  });

  it("year spans a real year, leap included", () => {
    expect(calendarWindow("year", "2026-09-23")).toMatchObject({
      from: "2026-01-01",
      to: "2027-01-01",
    });
    expect(calendarWindow("year", "2026-06-01").days).toHaveLength(365);
    // The off-by-one that hides until 31 December: a hardcoded 365 loses a day.
    expect(calendarWindow("year", "2028-06-01").days).toHaveLength(366);
  });

  it("schedule is a forward window from the anchor", () => {
    const w = calendarWindow("schedule", "2026-09-23");
    expect(w.from).toBe("2026-09-23");
    expect(w.days).toHaveLength(SCHEDULE_SPAN_DAYS);
  });

  it("month and year windows cross a year boundary correctly", () => {
    // The empty-range case: a December anchor whose `to` must roll into January.
    expect(calendarWindow("month", "2026-12-15")).toMatchObject({
      from: "2026-12-01",
      to: "2027-01-01",
    });
    expect(calendarWindow("month", "2026-12-15").days).toHaveLength(31);
  });
});

describe("shiftAnchor — each view moves by its OWN span", () => {
  it("moves a day, four days and a week", () => {
    expect(shiftAnchor("day", "2026-09-23", 1)).toBe("2026-09-24");
    expect(shiftAnchor("fourDay", "2026-09-23", 1)).toBe("2026-09-27");
    expect(shiftAnchor("fourDay", "2026-09-23", -1)).toBe("2026-09-19");
    expect(shiftAnchor("week", "2026-09-23", 1)).toBe("2026-09-30");
  });

  it("moves a month by a month, not thirty days", () => {
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftAnchor("month", "2026-12-15", 1)).toBe("2027-01-15");
  });

  it("moves a year by twelve months so it lands in January", () => {
    // 365 days from 1 January lands on 31 December of the same year on a leap
    // year — the next Year view would then show the year it just left.
    expect(shiftAnchor("year", "2028-01-01", 1)).toBe("2029-01-01");
    expect(calendarWindow("year", shiftAnchor("year", "2028-01-01", 1)).from).toBe("2029-01-01");
  });

  it("round-trips: forward then back returns to the start", () => {
    for (const mode of ALL_MODES) {
      const there = shiftAnchor(mode, "2026-09-15", 1);
      expect(shiftAnchor(mode, there, -1)).toBe("2026-09-15");
    }
  });
});

describe("yearMonths", () => {
  it("returns the twelve month-starts of the window's year", () => {
    const months = yearMonths("2026-01-01");
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2026-01-01");
    expect(months[11]).toBe("2026-12-01");
  });
});

describe("monthGridDays", () => {
  it("is always 42 cells so the grid never changes height", () => {
    for (const anchor of ["2026-02-01", "2026-09-01", "2028-02-01", "2026-08-01"]) {
      expect(monthGridDays(anchor)).toHaveLength(42);
    }
  });

  it("starts on the week containing the 1st, including trailing days of the previous month", () => {
    // 2026-09-01 is a Tuesday, so a Sunday-start grid opens on 30 August.
    expect(monthGridDays("2026-09-01")[0]).toBe("2026-08-30");
  });

  it("honours a Monday start", () => {
    expect(monthGridDays("2026-09-01", 1)[0]).toBe("2026-08-31");
  });
});

describe("rangeWindow — the sidebar's INCLUSIVE range as a half-open window", () => {
  it("adds the day the inclusive end leaves out", () => {
    // Without the +1 the last day of every range goes missing from every request.
    expect(rangeWindow({ from: "2026-09-23", to: "2026-09-25" })).toEqual({
      from: "2026-09-23",
      to: "2026-09-26",
      days: ["2026-09-23", "2026-09-24", "2026-09-25"],
    });
  });

  it("makes a one-day range one day wide", () => {
    expect(rangeWindow({ from: "2026-09-23", to: "2026-09-23" }).days).toEqual(["2026-09-23"]);
  });
});

describe("ganttWindow", () => {
  it("opens on two weeks from today when no range is picked", () => {
    const w = ganttWindow(undefined, "2026-09-23");
    expect(w.days).toHaveLength(GANTT_DEFAULT_DAYS);
    expect(w.from).toBe("2026-09-23");
    expect(w.clipped).toBe(false);
  });

  it("draws a range that fits unchanged", () => {
    const w = ganttWindow({ from: "2026-10-01", to: "2026-10-31" }, "2026-09-23");
    expect(w.days).toHaveLength(31);
    expect(w.clipped).toBe(false);
  });

  it("CLIPS a longer range to 31 days, and says so", () => {
    // The server refuses a wider window outright; the flag is what the banner
    // reads, so a clipped chart is never shown as the whole range.
    const w = ganttWindow({ from: "2026-10-01", to: "2026-11-15" }, "2026-09-23");
    expect(w.days).toHaveLength(GANTT_MAX_DAYS);
    expect(w.to).toBe("2026-11-01");
    expect(w.clipped).toBe(true);
  });
});
