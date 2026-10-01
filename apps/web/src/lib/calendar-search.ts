import { useNavigate, useRouterState } from "@tanstack/react-router";

import { isCivilDate, todayIn } from "@/lib/civil-date";
import { CALENDAR_VIEW_MODES, SCHEDULE_TABS } from "@/lib/types";

import type { CalendarViewMode, ScheduleTab } from "@/lib/types";

// THE SCHEDULE'S URL STATE, reachable from anywhere under the router.
//
// WHY THIS LIVES OUTSIDE THE ROUTE FILE
//
// The controls that drive the page do not live on the page. The date range and
// the action buttons are in the SIDEBAR, and the line and machine pickers are in
// the HEADER — both mounted by the `_app` layout, above the route. They still
// have to read and write the same search params the page does, because the URL
// is the single source of truth: a filtered schedule is something people send
// each other, and the back button must undo a navigation rather than leave.
//
// IT READS THE LOCATION, NOT THE MATCH, and that is a correction rather than a
// preference.
//
// This used to call `useSearch({ strict: false })`. That resolves against the
// CLOSEST MATCH — and the sidebar is rendered by `_app`, which has no
// `validateSearch` of its own, so the closest match's search is an empty object.
// The sidebar was therefore reading `{}` on every render: the mini calendar sat
// on today's month while the body was on another year, and picking a date
// appeared to do nothing to the highlight.
//
// It is a sharp bug because it LOOKS like it works. The route itself gets real
// values (it owns the contract), so the page behaves; only the controls mounted
// above it are blind, and only when the URL carries something.
//
// `useRouterState` reads the current location's search regardless of which match
// the caller sits in. The values arrive untyped either way, which is why
// validate() below is exported and used by the route's own `validateSearch` too —
// one parser, so the layout and the page cannot disagree about what a malformed
// URL means.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PARAMETERS
// ─────────────────────────────────────────────────────────────────────────────
//
//   tab        calendar | table | gantt        default calendar
//   view       the Calendar tab's view mode    default fourDay
//   from, to   the sidebar's date range, BOTH INCLUSIVE — it is the range a
//              person picked, and "23–25 Sep" reads as three days. Converted to
//              the half-open window the api takes in ONE place
//              (lib/calendar-window.ts `rangeWindow`).
//   date       the Calendar tab's anchor, when it has been paged away from `from`
//   lines      work-center ids
//   machines   work-unit ids — meaningless without `lines`, see below
//   page, size the Table tab's pager
//
// THE CALENDAR'S ANCHOR IS `date ?? from ?? today` (decision 2A). The range's
// start is where the Calendar opens and the view mode decides the window from
// there; paging with ‹ › writes `date` so the range the Table and Gantt read is
// left alone. Picking a new range CLEARS `date`, so the calendar follows the
// range again instead of staying wherever it was last paged to.
//
// Every default is applied when the value is READ, so `/calendar` with no
// parameters stays a valid link and a shared URL carries only what was changed.

// The plant's zone, not the browser's. "Which day is it" is a question about the
// site; every block already carries its own zone for rendering.
const PLANT_TIME_ZONE = "Asia/Jakarta";

const DEFAULT_TAB: ScheduleTab = "calendar";
const DEFAULT_VIEW: CalendarViewMode = "fourDay";
const DEFAULT_PAGE_SIZE = 10;
// The api's hard page-size cap.
const MAX_PAGE_SIZE = 100;

type CalendarSearch = {
  tab?: ScheduleTab;
  view?: CalendarViewMode;
  date?: string;
  from?: string;
  to?: string;
  lines?: number[];
  machines?: number[];
  page?: number;
  size?: number;
};

type DateRange = {
  from: string;
  // INCLUSIVE.
  to: string;
};

function positiveInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= max ? n : undefined;
}

// An id list, from either shape a URL can hand over: the router's own JSON
// encoding writes an ARRAY (`lines=%5B1%2C2%5D`), and a hand-typed or pasted link
// is far more likely to say `lines=1,2`. Both are honoured; junk entries are
// dropped one by one rather than discarding the whole list, and an empty result
// is ABSENT, never `[]` — so "no line filter" has exactly one representation.
function idList(value: unknown): number[] | undefined {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : typeof value === "number"
        ? [value]
        : [];
  const ids = [...new Set(raw.map((v) => positiveInt(v)).filter((v) => v !== undefined))];
  return ids.length === 0 ? undefined : ids;
}

function civil(value: unknown): string | undefined {
  return typeof value === "string" && isCivilDate(value) ? value : undefined;
}

// Hand-rolled rather than zod, matching routes/login.tsx: a handful of explicit
// checks a reviewer can read beats a schema in the browser bundle. Every field
// has a safe fallback rather than an error — a malformed URL should open the
// default schedule, not an error boundary.
function validateCalendarSearch(search: Record<string, unknown>): CalendarSearch {
  const from = civil(search.from);
  const rawTo = civil(search.to);
  // A `to` with no `from`, or one before it, describes no range anybody picked.
  // Dropped rather than swapped: a swapped range is a guess about which end was
  // the typo.
  const to = from !== undefined && rawTo !== undefined && rawTo >= from ? rawTo : undefined;

  const lines = idList(search.lines);

  return {
    tab: SCHEDULE_TABS.includes(search.tab as ScheduleTab)
      ? (search.tab as ScheduleTab)
      : undefined,
    view: CALENDAR_VIEW_MODES.includes(search.view as CalendarViewMode)
      ? (search.view as CalendarViewMode)
      : undefined,
    date: civil(search.date),
    from,
    to,
    lines,
    // A machine without a line is meaningless — the machine picker IS the
    // selected lines' roster — and would filter the page to nothing with a
    // control showing no line. Dropped rather than honoured.
    //
    // This parser cannot drop a machine that is on NO selected line: it does not
    // know the rosters. The picker that does (components/job/job-filters.tsx)
    // prunes those when the lines change.
    machines: lines === undefined ? undefined : idList(search.machines),
    page: positiveInt(search.page),
    size: positiveInt(search.size, MAX_PAGE_SIZE),
  };
}

// What a write through setSearch() does beyond merging, as a pure function so
// the rules are tested rather than trusted:
//
//   1. ANY CHANGE THAT IS NOT ITSELF A PAGE CHANGE RESETS THE PAGE. Page 7 of a
//      filtered list is usually past its end, and a Table showing "no jobs" on
//      a page that no longer exists reads as "the filter matched nothing".
//   2. CLEARING THE LINES CLEARS THE MACHINES, in the same write — see the
//      parser note above. Two writes would render a frame carrying a machine
//      filter with no line, and the request for that frame is an empty page.
//   3. A NEW RANGE CLEARS THE CALENDAR'S PAGED ANCHOR, so the calendar follows
//      the range the sidebar now shows.
//   4. AN EMPTY LIST IS WRITTEN AS ABSENT, so the URL has one spelling for "no
//      filter".
function mergeSearch(
  prev: Record<string, unknown>,
  next: Partial<CalendarSearch>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev, ...next };
  if (!("page" in next)) out.page = undefined;
  if ("lines" in next && (next.lines === undefined || next.lines.length === 0)) {
    out.lines = undefined;
    out.machines = undefined;
  }
  if ("machines" in next && (next.machines === undefined || next.machines.length === 0)) {
    out.machines = undefined;
  }
  if (("from" in next || "to" in next) && !("date" in next)) out.date = undefined;
  return out;
}

type CalendarState = {
  tab: ScheduleTab;
  view: CalendarViewMode;
  anchor: string;
  // Undefined when no range is picked: the Table then lists every job, and the
  // Gantt opens on its default window (lib/calendar-window.ts `ganttWindow`).
  range: DateRange | undefined;
  lines: number[];
  machines: number[];
  page: number;
  size: number;
  // A line or machine filter is set. Drives the "Clear filters" affordance.
  hasFilters: boolean;
  setSearch: (next: Partial<CalendarSearch>) => void;
};

function useCalendarSearch(): CalendarState {
  // Parsed here rather than trusted: the raw location search is whatever is in
  // the URL bar, so it gets the same validation the route applies.
  const raw = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const search = validateCalendarSearch(raw);
  const navigate = useNavigate();

  // `replace: true`: paging through weeks must not bury the back button under
  // thirty history entries.
  const setSearch = (next: Partial<CalendarSearch>) => {
    void navigate({
      to: "/calendar",
      search: (prev: Record<string, unknown>) => mergeSearch(prev, next),
      replace: true,
    });
  };

  const range =
    search.from === undefined ? undefined : { from: search.from, to: search.to ?? search.from };

  return {
    tab: search.tab ?? DEFAULT_TAB,
    view: search.view ?? DEFAULT_VIEW,
    anchor: search.date ?? search.from ?? todayIn(PLANT_TIME_ZONE),
    range,
    lines: search.lines ?? [],
    machines: search.machines ?? [],
    page: search.page ?? 1,
    size: search.size ?? DEFAULT_PAGE_SIZE,
    hasFilters: search.lines !== undefined || search.machines !== undefined,
    setSearch,
  };
}

export {
  DEFAULT_PAGE_SIZE,
  DEFAULT_TAB,
  DEFAULT_VIEW,
  PLANT_TIME_ZONE,
  mergeSearch,
  useCalendarSearch,
  validateCalendarSearch,
};
export type { CalendarSearch, CalendarState, DateRange };
