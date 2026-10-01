import { AlertTriangleIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { calendarWindow, shiftAnchor } from "@/lib/calendar-window";
import { MONTH_NAMES, month, todayIn, year } from "@/lib/civil-date";
import { useShiftBlocks } from "@/lib/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AgendaList } from "@/components/calendar/agenda-list";
import { DateGrid } from "@/components/calendar/date-grid";
import { TimeGrid } from "@/components/calendar/time-grid";
import { ViewSwitcher } from "@/components/calendar/view-switcher";

import type { CalendarViewMode, ShiftBlock } from "@/lib/types";

// THE CALENDAR SURFACE: navigation, the fetch, and which renderer draws it.
//
// THE GRID IS ALWAYS ON SCREEN. This is the correction that matters here.
//
// It used to swap the whole surface out for a message in three cases — loading,
// error, and "nothing in this window" — and the third is the one that made the
// product feel broken. Opening a month with nothing scheduled replaced the
// calendar with a sentence, so the user could not see the dates, could not tell
// which month they were on, and could not click a day to open it. A calendar
// with no jobs is not an empty state; it is a calendar, with empty days. That
// is what an empty day is FOR.
//
//   ┌─────────────────────────────────────────────┐
//   │ ‹ › Today   September 2026        [ Month ▾]│  always
//   ├─────────────────────────────────────────────┤
//   │ ⚠ could not load / showing part of period   │  a BANNER when it applies
//   ├─────────────────────────────────────────────┤
//   │ SUN  MON  TUE  WED  THU  FRI  SAT           │
//   │  30   31  Sep1   2    3    4    5           │  ALWAYS — empty days are
//   │   6    7    8    9   10   11   12           │  simply empty
//   └─────────────────────────────────────────────┘
//
// So error and loading are now BANNERS OVER the grid rather than replacements
// for it. The error one is deliberately loud: an empty grid drawn after a failed
// fetch would otherwise read as "nothing is scheduled", which is the dangerous
// direction on a job calendar.
//
// THE ONE PLACE A MESSAGE STILL REPLACES CONTENT is the Schedule view, and it is
// not an exception to the rule. That view is a LIST, not a grid — there are no
// dates drawn to keep — so "nothing scheduled in this period" is the honest
// rendering of an empty one. AgendaList owns that itself.
//
// A BLOCK OPENS THE JOB'S READ-ONLY DETAIL on the block's business date
// (`onSelectBlock`), never the edit form — see occurrence-block.tsx.
//
// `isPending` REMAINS THE TRAP TO AVOID. A React Query gated off by
// `enabled: false` reports `status: "pending"` forever, so branching on it would
// mean a permanent loading state. The branch below is on whether there is DATA.

type CalendarViewProps = {
  viewMode: CalendarViewMode;
  anchor: string;
  timeZone: string;
  filters: { workCenterIds: number[]; workUnitIds: number[] };
  onAnchorChange: (anchor: string) => void;
  onViewModeChange: (mode: CalendarViewMode) => void;
  // A block was clicked: open that job's READ-ONLY detail on the block's day.
  // Optional so a renderer test can draw the grid without one.
  onSelectBlock?: (block: ShiftBlock) => void;
};

function CalendarView({
  viewMode,
  anchor,
  timeZone,
  filters,
  onAnchorChange,
  onViewModeChange,
  onSelectBlock,
}: CalendarViewProps) {
  const { t } = useTranslation("jobs");
  const window = calendarWindow(viewMode, anchor);

  // The key and the request are built from ONE object (lib/queries.ts), so a
  // filter can never be sent without also being part of the cache key.
  const query = useShiftBlocks({
    from: window.from,
    to: window.to,
    ...filters,
  });

  const occurrences = query.data?.blocks ?? [];

  // Clicking a date anywhere drops into the Day view on it — the Year view's
  // density cells and the Month view's "+3 more" both route here.
  const openDate = (date: string) => {
    onAnchorChange(date);
    onViewModeChange("day");
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label={t("calendar.previousPeriod")}
            onClick={() => onAnchorChange(shiftAnchor(viewMode, anchor, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={t("calendar.nextPeriod")}
            onClick={() => onAnchorChange(shiftAnchor(viewMode, anchor, 1))}
          >
            <ChevronRightIcon />
          </Button>
          <Button variant="outline" onClick={() => onAnchorChange(todayIn(timeZone))}>
            {t("common.today")}
          </Button>
          <h2 className="ml-2 text-base font-semibold">{periodLabel(viewMode, window.from)}</h2>
          {/* Quiet, and beside the heading rather than over the grid. Only on
              the first load — paging keeps the previous window on screen via
              `placeholderData`. */}
          {query.data === undefined && !query.isError ? (
            <span className="text-muted-foreground ml-2 text-xs">{t("calendar.loading")}</span>
          ) : null}
        </div>

        <ViewSwitcher value={viewMode} onChange={onViewModeChange} />
      </div>

      {/* TRUNCATION IS NEVER SILENT. The server caps how many blocks one
          request may return; without this banner the calendar would simply be
          missing shifts, which is the dangerous direction. */}
      {query.data?.truncated ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{t("calendar.partialPeriod")}</AlertTitle>
          <AlertDescription>{t("calendar.truncated")}</AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{t("calendar.loadError")}</AlertTitle>
          <AlertDescription>{t("calendar.emptyBecauseError")}</AlertDescription>
        </Alert>
      ) : null}

      {/* THE GRID, UNCONDITIONALLY. `aria-busy` while the first response is in
          flight, so assistive tech is told the days may still fill in — the
          alternative, hiding the calendar behind a skeleton, is the thing this
          component was corrected for. */}
      <div
        aria-busy={query.data === undefined}
        className={cn(query.data === undefined && "opacity-60")}
      >
        {viewMode === "schedule" ? (
          <AgendaList occurrences={occurrences} timeZone={timeZone} onSelect={onSelectBlock} />
        ) : viewMode === "month" || viewMode === "year" ? (
          <DateGrid
            mode={viewMode}
            from={window.from}
            occurrences={occurrences}
            timeZone={timeZone}
            onOpenDate={openDate}
            onSelect={onSelectBlock}
          />
        ) : (
          <TimeGrid
            days={window.days}
            occurrences={occurrences}
            timeZone={timeZone}
            onSelect={onSelectBlock}
          />
        )}
      </div>
    </div>
  );
}

// What the period is called above the grid. Derived from the WINDOW rather than
// the anchor, so it always names what is actually on screen — an anchor of
// 23 September in Month view must read "September 2026", not "23 September".
function periodLabel(mode: CalendarViewMode, from: string): string {
  if (mode === "year") return String(year(from));
  return `${MONTH_NAMES[month(from) - 1]} ${year(from)}`;
}

export { CalendarView, periodLabel };
