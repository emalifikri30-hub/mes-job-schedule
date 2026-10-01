import {
  addDays,
  addMonths,
  daysInMonth,
  startOfMonth,
  startOfWeek,
  startOfYear,
} from "@/lib/civil-date";

import type { CalendarViewMode } from "@/lib/types";

// THE ONE PLACE THAT ANSWERS "WHICH DATES ARE ON SCREEN".
//
// Every caller needs that answer and they must all get the same one:
//
//   components/calendar/calendar-view.tsx   the Calendar tab's window
//   lib/queries.ts the React Query key AND the request's from/to
//   components/calendar/mini-calendar.tsx   which days to highlight
//   components/calendar/{time-grid,date-grid,agenda-list}.tsx  what to draw
//   the prev / next / today buttons
//   components/job/{job-table,gantt-view}.tsx  the sidebar range, as a window
//
// A second copy of this arithmetic is how the mini-calendar highlights a date
// the grid is not showing — a bug with no error and no wrong number, just a
// highlight in the wrong place that nobody can explain.
//
//   ┌──────────────── CalendarWindow ────────────────┐
//   │ from   inclusive civil date                    │
//   │ to     EXCLUSIVE civil date                    │
//   │ days   the dates to render, from .. to-1       │
//   └────────────────────────────────────────────────┘
//
// `to` IS EXCLUSIVE, matching the half-open `>= from AND < to` the server's
// window predicate uses. Both halves being half-open is what stops an event on
// the boundary rendering twice or not at all.

type CalendarWindow = {
  from: string;
  to: string;
  days: string[];
};

// The Schedule (agenda) view has no natural end — it is "what's coming up".
// 90 days is a quarter, which is what the view is for, and it is well inside the
// server's 400-day cap so the request can never be rejected for its width.
const SCHEDULE_SPAN_DAYS = 90;

// How many days each grid view spans. Month and Year are computed, because
// their length depends on the anchor.
const FIXED_SPANS: Partial<Record<CalendarViewMode, number>> = {
  day: 1,
  fourDay: 4,
  week: 7,
  schedule: SCHEDULE_SPAN_DAYS,
};

function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Where each view starts, given the anchor the user navigated to.
//
// Day, 4 Days and Schedule START AT THE ANCHOR — they are relative views, and
// snapping "4 days from Wednesday" back to Sunday would move the page under the
// user after they clicked a date. Week, Month and Year snap, because those words
// name a fixed block of the calendar and a "week" that starts on Wednesday is
// not one.
function windowStart(mode: CalendarViewMode, anchor: string, weekStartsOn: number): string {
  switch (mode) {
    case "week":
      return startOfWeek(anchor, weekStartsOn);
    case "month":
      return startOfMonth(anchor);
    case "year":
      return startOfYear(anchor);
    case "day":
    case "fourDay":
    case "schedule":
      return anchor;
  }
}

function spanDays(mode: CalendarViewMode, from: string): number {
  const fixed = FIXED_SPANS[mode];
  if (fixed !== undefined) return fixed;
  if (mode === "month") return daysInMonth(from);
  // Year. Computed rather than 365 so a leap year is not one day short — the
  // kind of off-by-one that hides until the last day of December.
  return Math.round(
    (Date.parse(`${Number(from.slice(0, 4)) + 1}-01-01T00:00:00Z`) -
      Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

function calendarWindow(mode: CalendarViewMode, anchor: string, weekStartsOn = 0): CalendarWindow {
  const from = windowStart(mode, anchor, weekStartsOn);
  const to = addDays(from, spanDays(mode, from));
  return { from, to, days: enumerateDays(from, to) };
}

// Where the prev / next buttons move the anchor.
//
// A view moves by ITS OWN span, not by a day: "next" on the Month view means the
// next month, and on 4 Days it means the next four days. Year steps by 12 months
// rather than 365 days so it lands on 1 January and not on 31 December.
function shiftAnchor(mode: CalendarViewMode, anchor: string, direction: 1 | -1): string {
  switch (mode) {
    case "day":
      return addDays(anchor, direction);
    case "fourDay":
      return addDays(anchor, 4 * direction);
    case "week":
      return addDays(anchor, 7 * direction);
    case "schedule":
      return addDays(anchor, SCHEDULE_SPAN_DAYS * direction);
    case "month":
      return addMonths(anchor, direction);
    case "year":
      return addMonths(anchor, 12 * direction);
  }
}

// The 12 month-start dates a Year view draws. Derived from the window rather
// than from the anchor so the two can never disagree about which year it is.
function yearMonths(from: string): string[] {
  return Array.from({ length: 12 }, (_, i) => addMonths(startOfYear(from), i));
}

// The six-week grid a Month view draws, INCLUDING the leading and trailing days
// from the neighbouring months.
//
// Always 42 cells, never 28/35/42 depending on the month: a grid that changes
// height as you page through the year makes the whole page jump.
function monthGridDays(from: string, weekStartsOn = 0): string[] {
  const gridStart = startOfWeek(startOfMonth(from), weekStartsOn);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

// THE SIDEBAR'S RANGE AS A WINDOW. The URL range is INCLUSIVE — it is what a
// person picked, and "23–25 Sep" is three days — while every request is
// half-open. This is the one conversion between the two; doing it inline at
// each call site is how one of them forgets the `+ 1` and the last day of every
// range quietly goes missing.
function rangeWindow(range: { from: string; to: string }): CalendarWindow {
  const to = addDays(range.to, 1);
  return { from: range.from, to, days: enumerateDays(range.from, to) };
}

// The widest window the Gantt draws, and the api's own cap on GET /jobs/plan
// (decision 17A). At three shift columns a day, 31 days is already 93 columns
// of horizontal scroll; past that the chart stops being readable before it
// stops being renderable.
const GANTT_MAX_DAYS = 31;

// Where the Gantt opens when no range is picked: two weeks from today, which is
// the planning horizon a production plan is written for.
const GANTT_DEFAULT_DAYS = 14;

// The Gantt's window, and whether it had to CLIP the range to get it.
//
// `clipped` travels WITH the window, the same way `truncated` travels with the
// server's answer: a caller cannot get the dates without also being handed the
// fact that the picked range was longer, so a clipped chart is never shown as
// if it were the whole range.
function ganttWindow(
  range: { from: string; to: string } | undefined,
  today: string,
): CalendarWindow & { clipped: boolean } {
  if (range === undefined) {
    return {
      ...rangeWindow({ from: today, to: addDays(today, GANTT_DEFAULT_DAYS - 1) }),
      clipped: false,
    };
  }
  const window = rangeWindow(range);
  if (window.days.length <= GANTT_MAX_DAYS) return { ...window, clipped: false };
  return {
    ...rangeWindow({ from: range.from, to: addDays(range.from, GANTT_MAX_DAYS - 1) }),
    clipped: true,
  };
}

export {
  GANTT_DEFAULT_DAYS,
  GANTT_MAX_DAYS,
  SCHEDULE_SPAN_DAYS,
  calendarWindow,
  ganttWindow,
  rangeWindow,
  enumerateDays,
  monthGridDays,
  shiftAnchor,
  yearMonths,
};
export type { CalendarWindow };
