import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { MONTH_NAMES, dayOfMonth, month, todayIn } from "@/lib/civil-date";
import { monthGridDays, yearMonths } from "@/lib/calendar-window";
import { blockKey, countByDate } from "@/lib/layout-occurrences";
import { OccurrenceBlock } from "@/components/calendar/occurrence-block";

import type { ShiftBlock } from "@/lib/types";

// THE DATE GRID, and TWO of the six views are this component:
//
//   DateGrid mode="month" ──▶ Month   — shift blocks, as rows in each cell
//   DateGrid mode="year"  ──▶ Year    — DENSITY ONLY, twelve mini-months
//
// `mode` IS a real branch here, unlike TimeGrid's absent one, because the two
// views draw genuinely different things — and the difference is a decision worth
// keeping stated:
//
// THE YEAR VIEW IS TWELVE REAL MONTH GRIDS, not a heat map.
//
// It was a density ramp — a day tinted by how many blocks it held. That was the
// wrong instrument twice over: a ramp over an unknown maximum means "busy"
// differs between months, and more importantly a year view is READ AS A
// CALENDAR. People look for a date in it. Numbers you can read and days you can
// click are the whole job; the shifts themselves belong in the Day view, one
// click away. (Clicking a DATE is navigation to the Day view; clicking a Month
// cell's BLOCK opens that job's read-only detail. They are different acts on
// different targets.)
//
// A day that HAS something is marked with a dot under its number — present or
// absent, not a shade, because a reader cannot rank tints but can see a dot.
//
//   Month                                    Year
//   ┌─────┬─────┬─────┬─────┬─────┬─────┬──┐ ┌──────┬──────┬──────┐
//   │ SUN │ MON │ TUE │ WED │ THU │ FRI │  │ │ Jan  │ Feb  │ Mar  │
//   ├─────┼─────┼─────┼─────┼─────┼─────┼──┤ │▪▪·▪· │·▪▪·· │▪···▪ │
//   │  31 │Jun 1│  2  │  3  │  4  │  5  │  │ ├──────┼──────┼──────┤
//   │     │●7am │●7am │     │     │●7am │  │ │ Apr  │ May  │ Jun  │
//   │     │●3pm │ S1  │     │     │●3pm │  │ └──────┴──────┴──────┘
//   │     │●11pm│     │     │     │     │  │
//   └─────┴─────┴─────┴─────┴─────┴─────┴──┘
//      ● = one shift of one job, by BUSINESS date — Friday's S3 sits in
//          Friday's cell even though most of it runs on Saturday
//
// THE FIRST OF A MONTH CARRIES ITS MONTH NAME ("Jun 1"), which is how a reader
// tells where the leading and trailing days belong without counting back. It is
// also the only label in the grid that is not just a number.

// How many block rows fit a cell before the rest become "+N more".
//
// Three, not "as many as fit": a cell that grows with its content makes every
// row in the grid a different height, and a month with one busy day becomes a
// month where six other weeks are mostly whitespace. A fixed cap keeps the grid
// rectangular and puts the overflow one click away.
const MAX_ROWS_PER_CELL = 3;

type DateGridProps = {
  mode: "month" | "year";
  from: string;
  occurrences: ShiftBlock[];
  timeZone: string;
  onOpenDate: (date: string) => void;
  onSelect?: (block: ShiftBlock) => void;
};

function DateGrid({ mode, from, occurrences, timeZone, onOpenDate, onSelect }: DateGridProps) {
  const { t } = useTranslation("jobs");
  const today = todayIn(timeZone);
  const weekdayNames = t("calendar.weekdays", { returnObjects: true }) as string[];

  // Bucketed ONCE rather than filtered per cell: a month grid is 42 cells, and
  // filtering the whole occurrence list in each of them is 42 passes over it on
  // every render.
  const byDate = useMemo(() => {
    const out = new Map<string, ShiftBlock[]>();
    for (const o of occurrences) {
      const list = out.get(o.occurrenceDate);
      if (list === undefined) out.set(o.occurrenceDate, [o]);
      else list.push(o);
    }
    // Clock order inside a day — S1, S2, S3 — with the job id breaking a tie so
    // two jobs on one shift keep a stable order between renders.
    for (const list of out.values()) {
      list.sort((a, b) =>
        a.startsAt === b.startsAt ? a.jobId - b.jobId : a.startsAt < b.startsAt ? -1 : 1,
      );
    }
    return out;
  }, [occurrences]);

  const counts = useMemo(() => countByDate(occurrences), [occurrences]);

  if (mode === "year") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {yearMonths(from).map((monthStart) => (
          <MiniMonth
            key={monthStart}
            monthStart={monthStart}
            counts={counts}
            today={today}
            onOpenDate={onOpenDate}
          />
        ))}
      </div>
    );
  }

  const cells = monthGridDays(from);
  const currentMonth = month(from);

  return (
    <div className="bg-border grid grid-cols-7 gap-px overflow-hidden rounded-lg border">
      {weekdayNames.map((name) => (
        <div
          key={name}
          className="bg-background text-muted-foreground px-2 py-1.5 text-center text-[11px] font-medium tracking-wide"
        >
          {name}
        </div>
      ))}

      {cells.map((date) => {
        const dayOccurrences = byDate.get(date) ?? [];
        const shown = dayOccurrences.slice(0, MAX_ROWS_PER_CELL);
        const hidden = dayOccurrences.length - shown.length;
        // Days from the neighbouring months are drawn, not blanked: an empty
        // leading row makes the grid look broken, and they are real days
        // somebody may want to click. Only the NUMBER dims — an earlier version
        // also tinted the cell, which turned the first and last rows into grey
        // slabs and made the grid look like it had a rendering fault.
        const outside = month(date) !== currentMonth;
        const isToday = date === today;
        const first = dayOfMonth(date) === 1;

        return (
          <div key={date} className="bg-background flex min-h-24 flex-col gap-0.5 p-1 md:min-h-28">
            <button
              type="button"
              onClick={() => onOpenDate(date)}
              aria-label={t("calendar.openDate", { date })}
              className={cn(
                "mx-auto mb-0.5 flex h-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs",
                "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
                outside && "text-muted-foreground",
                isToday && "bg-primary text-primary-foreground font-semibold hover:bg-primary/90",
              )}
            >
              {/* "Jun 1" rather than "1" — see the header. */}
              {first ? `${MONTH_NAMES[month(date) - 1]} ${dayOfMonth(date)}` : dayOfMonth(date)}
            </button>

            {shown.map((o) => (
              <OccurrenceBlock key={blockKey(o)} occurrence={o} onSelect={onSelect} />
            ))}

            {hidden > 0 ? (
              <button
                type="button"
                onClick={() => onOpenDate(date)}
                className="text-muted-foreground hover:text-foreground hover:bg-accent rounded px-1 text-left text-xs leading-5"
              >
                {t("calendar.more", { count: hidden })}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// One month of the Year view: a real, readable month grid.
function MiniMonth({
  monthStart,
  counts,
  today,
  onOpenDate,
}: {
  monthStart: string;
  counts: Map<string, number>;
  today: string;
  onOpenDate: (date: string) => void;
}) {
  const { t } = useTranslation("jobs");
  const cells = monthGridDays(monthStart);
  const currentMonth = month(monthStart);
  const weekdayShort = t("calendar.weekdaysShort", { returnObjects: true }) as string[];

  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1 px-1 text-sm font-medium">{MONTH_NAMES[currentMonth - 1]}</div>
      <div className="grid grid-cols-7">
        {weekdayShort.map((name, i) => (
          <div key={i} className="text-muted-foreground pb-1 text-center text-[10px]">
            {/* One letter at this scale: "SUN" in a 24px cell wraps. */}
            {name}
          </div>
        ))}
        {cells.map((date) => {
          const count = counts.get(date) ?? 0;
          // Days from the neighbouring months are rendered blank here, unlike in
          // the month view. Twelve grids side by side already carry their own
          // boundaries; repeating each month's neighbours would print every date
          // three times across the year and make it unreadable as a lookup.
          if (month(date) !== currentMonth) {
            return <span key={date} className="aspect-square" aria-hidden />;
          }
          const isToday = date === today;
          return (
            <button
              key={date}
              type="button"
              onClick={() => onOpenDate(date)}
              aria-label={t("calendar.shiftsOnDate", { date, count })}
              title={t("calendar.shiftsOnDateTitle", { date, count })}
              className={cn(
                "relative flex aspect-square flex-col items-center justify-center rounded-full text-[11px] leading-none",
                "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
                isToday && "bg-primary text-primary-foreground font-semibold hover:bg-primary/90",
              )}
            >
              <span>{dayOfMonth(date)}</span>
              {/* Present or absent, never a shade — a reader cannot rank tints
                  but can see a dot. The count is in the accessible name. */}
              <span
                aria-hidden
                className={cn(
                  "absolute bottom-0.5 size-1 rounded-full",
                  count > 0 ? (isToday ? "bg-primary-foreground" : "bg-event") : "bg-transparent",
                )}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { DateGrid, MAX_ROWS_PER_CELL };
