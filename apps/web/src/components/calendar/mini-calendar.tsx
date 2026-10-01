import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  MONTH_NAMES,
  addMonths,
  dayOfMonth,
  month,
  startOfMonth,
  todayIn,
  year,
} from "@/lib/civil-date";
import { monthGridDays } from "@/lib/calendar-window";
import { Button } from "@/components/ui/button";

import type { DateRange } from "@/lib/calendar-search";
import type { MouseEvent } from "react";

// THE SIDEBAR'S DATE PICKER, in two modes:
//
//   single  one date — what this was until the Table and Gantt tabs arrived
//   range   the sidebar's DATE RANGE (decision 2A): the Table lists the jobs
//           overlapping it, the Gantt draws it, and on the Calendar tab its
//           start is the anchor the view mode builds a window from
//
// A range is two clicks — start, then end, in either order — or a SHIFT-click
// that extends the current range from its start. No date-picker library: this
// grid already existed and already knew which dates it draws.
//
// IT IS NOT CONTROLLED BY THE VIEW SWITCHER, and that is the whole correction
// this file exists to record.
//
// It used to take the view mode and highlight `calendarWindow(view, anchor)` —
// every date the main grid was showing. (Range mode highlights a range too, but
// it is the range the user PICKED — a filter they can see — not the window a
// view mode happens to span.) That reads fine in 4-day view and is
// nonsense everywhere else: switching the body to Year lit up all 365 days in
// the sidebar, and Month lit up a whole month, so the one thing the control is
// for — showing WHICH DATE IS SELECTED — was buried under a block of highlight.
//
//   view switcher ──▶ the calendar in the BODY          (Day/Week/Month/…)
//   mini calendar ──▶ the DATE that calendar opens on   (and nothing else)
//
// The two meet at the anchor date and nowhere else. So this component takes no
// view mode, and adding one back is the regression to watch for.
//
// ITS MONTH CURSOR IS ALSO ITS OWN. Paging to November to look at something must
// not move the main calendar — only CLICKING a day does that. The cursor follows
// the selected date (or the range's start) when that changes from outside, so
// the picker never ends up showing a month unrelated to what is on screen.

type MiniCalendarProps = { timeZone: string } & (
  | {
      mode?: "single";
      // HIGHLIGHTED, singular — whatever view the body happens to be in.
      selected: string;
      onPick: (date: string) => void;
    }
  | {
      mode: "range";
      // Undefined when nothing is picked; the grid then opens on `fallback`'s
      // month (the calendar's anchor) with nothing highlighted.
      range: DateRange | undefined;
      fallback: string;
      onRangePick: (range: DateRange) => void;
    }
);

function MiniCalendar(props: MiniCalendarProps) {
  const { t } = useTranslation("jobs");
  const { timeZone } = props;
  const weekdayInitials = t("calendar.weekdaysShort", { returnObjects: true }) as string[];
  const focus = props.mode === "range" ? (props.range?.from ?? props.fallback) : props.selected;

  const [cursor, setCursor] = useState(() => startOfMonth(focus));
  // The first click of a two-click range. Local, not in the URL: a half-picked
  // range is not something anybody shares, and the URL already holds the
  // one-day range that first click wrote.
  const [pendingStart, setPendingStart] = useState<string | undefined>();

  // Follows the selection when it moves from OUTSIDE this component — pressing
  // Today, or clicking a date in the main grid. Browsing inside the picker is
  // left alone, because `startOfMonth(focus)` only changes when the selection
  // does.
  useEffect(() => {
    setCursor(startOfMonth(focus));
  }, [focus]);

  const pick = (date: string, event: MouseEvent) => {
    if (props.mode !== "range") {
      props.onPick(date);
      return;
    }
    const order = (a: string, b: string): DateRange =>
      a <= b ? { from: a, to: b } : { from: b, to: a };

    if (event.shiftKey && props.range !== undefined) {
      setPendingStart(undefined);
      props.onRangePick(order(props.range.from, date));
    } else if (pendingStart === undefined) {
      // The first click is already a valid one-day range, written at once so
      // the page follows the click instead of waiting for a second one that
      // may never come.
      setPendingStart(date);
      props.onRangePick({ from: date, to: date });
    } else {
      setPendingStart(undefined);
      props.onRangePick(order(pendingStart, date));
    }
  };

  const today = todayIn(timeZone);
  const cells = monthGridDays(cursor);
  const shown = month(cursor);

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-sm font-medium">
          {MONTH_NAMES[shown - 1]} {year(cursor)}
        </div>
        <div className="flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("calendar.previousMonth")}
            onClick={() => setCursor(addMonths(cursor, -1))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("calendar.nextMonth")}
            onClick={() => setCursor(addMonths(cursor, 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px">
        {weekdayInitials.map((initial, i) => (
          <div key={i} className="text-muted-foreground py-1 text-center text-[11px]">
            {initial}
          </div>
        ))}
        {cells.map((date) => {
          const outside = month(date) !== shown;
          const range = props.mode === "range" ? props.range : undefined;
          // The ENDS are the solid fill; the days between are a tint, so a
          // two-week range reads as a span with two edges rather than a slab.
          const isSelected =
            props.mode === "range"
              ? range !== undefined && (date === range.from || date === range.to)
              : date === props.selected;
          const inRange = range !== undefined && date > range.from && date < range.to;
          const isToday = date === today;
          return (
            <button
              key={date}
              type="button"
              onClick={(event) => pick(date, event)}
              aria-label={date}
              aria-current={isSelected ? "date" : undefined}
              aria-pressed={props.mode === "range" ? isSelected || inRange : undefined}
              className={cn(
                "flex aspect-square items-center justify-center rounded-full text-xs",
                "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
                outside && "text-muted-foreground/50",
                inRange && "bg-primary/15 rounded-none",
                // Today is a tint; the SELECTION is the solid fill. Both can be
                // true at once, and the fill has to win or the control stops
                // showing what it was clicked on.
                isToday && !isSelected && "text-primary font-semibold",
                isSelected && "bg-primary text-primary-foreground hover:bg-primary/90 font-medium",
              )}
            >
              {dayOfMonth(date)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { MiniCalendar };
