import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { dayOfMonth, dayOfWeek, todayIn } from "@/lib/civil-date";
import { blockKey, formatHourLabel, formatZoneOffset, layoutDay } from "@/lib/layout-occurrences";
import { OccurrenceBlock } from "@/components/calendar/occurrence-block";

import type { ShiftBlock } from "@/lib/types";

// THE HOUR GRID, and THREE of the six views are this component with a different
// number of days:
//
//   TimeGrid days=1  ──▶ Day
//   TimeGrid days=4  ──▶ 4 Days   (the default view)
//   TimeGrid days=7  ──▶ Week
//
// There is no `mode` prop, and that is the point. The three views differ only in
// how many columns they draw, so a mode would be a flag the component has to
// branch on to reproduce a difference that does not exist — the shortest path to
// the Week view quietly gaining a behaviour the 4-day view lacks.
//
//        ┌──────┬─────────┬─────────┬─────────┬─────────┐
//   00   │ 00:00│ ┌─────┐ │ ┌─────┐ │         │         │  <- the previous day's
//   ...  │  ... │ │ S3  │ │ │ S3  │ │         │         │     S3, continued
//   07   │ 07:00│ ├─────┤ │ ├──┬──┤ │         │         │
//   ...  │  ... │ │ S1  │ │ │A │B │ │         │         │  <- two jobs on one
//   15   │ 15:00│ ├─────┤ │ └──┴──┘ │         │         │     shift split the
//   ...  │  ... │ │ S2  │ │         │         │         │     column
//   23   │ 23:00│ ├─────┤ │         │         │         │
//        │      │ │ S3  │ │         │         │         │  <- runs on into the
//        └──────┴─┴─────┴─┴─────────┴─────────┴─────────┘     next column
//          gutter  ← one column per day, equal width →
//
// The hour gutter is a sibling column rather than a background image so the
// labels stay selectable and scale with the user's font size.

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const HOUR_HEIGHT_REM = 3;

// WHERE THE GRID OPENS when there is nothing to scroll to.
//
// Not midnight. A 24-hour grid that starts at 00:00 shows six empty hours and
// pushes the day shift below the fold — which is what this component did until
// it was looked at in a browser, and no test could have said so. 7am is when
// shift 1 starts, so the first thing on screen is the beginning of the working
// day. (The scroll below lands an hour ABOVE the first block, so a morning with
// an S3 continuation still shows it starting at midnight.)
const DEFAULT_SCROLL_HOUR = 7;

// One hour of padding above the first block, so it does not sit flush against
// the top edge with no context above it.
const SCROLL_CONTEXT_HOURS = 1;

// Upper-case and abbreviated, matching the month grid's header so the two
// views read as the same calendar.
type TimeGridProps = {
  days: string[];
  occurrences: ShiftBlock[];
  timeZone: string;
  onSelect?: (block: ShiftBlock) => void;
};

function TimeGrid({ days, occurrences, timeZone, onSelect }: TimeGridProps) {
  const { t } = useTranslation("jobs");
  const weekdayNames = t("calendar.weekdays", { returnObjects: true }) as string[];
  // Memoised on the inputs the layout actually depends on: this runs on every
  // render of a scrolling grid, and the overlap sweep is O(n log n) per day.
  const layouts = useMemo(
    () => days.map((date) => layoutDay(occurrences, date)),
    [days, occurrences],
  );

  const today = todayIn(timeZone);

  // SCROLL TO THE WORK, not to midnight. The earliest timed block in the window
  // if there is one, else the start of the working day.
  const scroller = useRef<HTMLDivElement>(null);
  const firstHour = useMemo(() => {
    const tops = layouts.flatMap((l) => l.timed.map((b) => b.topPct));
    if (tops.length === 0) return DEFAULT_SCROLL_HOUR;
    return Math.floor((Math.min(...tops) / 100) * 24);
  }, [layouts]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const remInPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    node.scrollTop = Math.max(0, (firstHour - SCROLL_CONTEXT_HOURS) * HOUR_HEIGHT_REM * remInPx);
  }, [firstHour]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border">
      {/* Header: one cell per day, plus a spacer over the hour gutter. */}
      <div className="bg-muted/40 flex border-b">
        {/* Whose clock these times are. See formatZoneOffset. */}
        <div className="text-muted-foreground flex w-14 shrink-0 items-end justify-end pr-2 pb-1 text-[10px] md:w-16">
          {formatZoneOffset(timeZone)}
        </div>
        {days.map((date) => (
          <div
            key={date}
            className={cn(
              "flex-1 border-l px-2 py-2 text-center",
              date === today && "bg-primary/5",
            )}
          >
            <div className="text-muted-foreground text-[11px] font-medium tracking-wide">
              {weekdayNames[dayOfWeek(date)]}
            </div>
            <div
              className={cn(
                "text-sm font-semibold",
                date === today &&
                  "bg-primary text-primary-foreground mx-auto flex size-7 items-center justify-center rounded-full",
              )}
            >
              {dayOfMonth(date)}
            </div>
          </div>
        ))}
      </div>

      <div ref={scroller} className="max-h-[60vh] overflow-y-auto">
        <div className="flex" style={{ height: `${24 * HOUR_HEIGHT_REM}rem` }}>
          <div className="w-14 shrink-0 md:w-16">
            {HOURS.map((hour) => (
              <div
                key={hour}
                className="text-muted-foreground relative text-right text-xs"
                style={{ height: `${HOUR_HEIGHT_REM}rem` }}
              >
                {/* Nudged up so the label sits ON the line rather than under it,
                    and the midnight label is suppressed — it would be clipped by
                    the top edge. */}
                <span className="absolute -top-2 right-2">
                  {hour === 0 ? "" : formatHourLabel(hour)}
                </span>
              </div>
            ))}
          </div>

          {layouts.map((layout) => (
            <div
              key={layout.date}
              className={cn(
                "relative min-w-0 flex-1 border-l",
                layout.date === today && "bg-primary/5",
              )}
            >
              {HOURS.map((hour) => (
                <div
                  key={hour}
                  className="border-b border-dashed last:border-b-0"
                  style={{ height: `${HOUR_HEIGHT_REM}rem` }}
                />
              ))}

              {layout.timed.map((block) => (
                <div
                  key={blockKey(block.occurrence)}
                  className="absolute px-px"
                  style={{
                    top: `${block.topPct}%`,
                    height: `${block.heightPct}%`,
                    // Columns split the width evenly. Computed here rather than
                    // with a CSS grid because the number of columns is a
                    // property of one cluster, not of the day.
                    left: `${(block.column / block.columnCount) * 100}%`,
                    width: `${(1 / block.columnCount) * 100}%`,
                  }}
                >
                  <OccurrenceBlock
                    occurrence={block.occurrence}
                    // Below ~1 hour there is one line of room, so the block
                    // collapses to the same single row the month cells use.
                    variant={block.heightPct < 4 ? "row" : "block"}
                    className="h-full"
                    onSelect={onSelect}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { TimeGrid };
