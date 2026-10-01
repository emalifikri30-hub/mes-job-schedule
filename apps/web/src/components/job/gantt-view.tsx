import { AlertTriangleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/api";
import { GANTT_MAX_DAYS, ganttWindow } from "@/lib/calendar-window";
import {
  MONTH_NAMES,
  WEEKDAY_SHORT,
  dayOfMonth,
  dayOfWeek,
  formatCivilRange,
  month,
  todayIn,
} from "@/lib/civil-date";
import { SHIFTS_PER_DAY, buildGantt, formatSkuQuantity } from "@/lib/gantt-bars";
import { usePlanItems } from "@/lib/queries";
import { SHIFTS } from "@/lib/shift";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { DateRange } from "@/lib/calendar-search";
import type { GanttBar, GanttLineGroup } from "@/lib/gantt-bars";
import type { CSSProperties } from "react";

// THE GANTT TAB: the plan, by line and machine, one column per shift.
//
//   ┌────────────────────────┬───────────┬───────────┬───────────┐
//   │ Production             │  Fri 25   │  Sat 26   │  Sun 27   │
//   │                        │ 1   2   3 │ 1   2   3 │ 1   2   3 │
//   ├────────────┬───────────┼───────────┴───────────┼───────────┤
//   │ Line 1     │ Mach 1.1  │ [SKU A · 400 CARTON  ]│           │
//   │ SKU A ·    ├───────────┼───────────┬───────────┴───┐       │
//   │ 600 CARTON │ Mach 1.2  │           │[SKU A · 200 C]│       │
//   └────────────┴───────────┴───────────┴───────────────┴───────┘
//     sticky       sticky      ← scrolls horizontally →
//
// WHAT A BAR MEANS is decided in lib/gantt-bars.ts, not here: a maximal run of
// contiguous ticked shifts for one (job, machine, SKU, unit), carrying each
// row's target ONCE, in the bar holding its first ticked shift (decision 9A).
// The line cell lists that line's totals per SKU PER UNIT.
//
// ONLY THE BARS ARE DOM NODES. The shift and day gridlines are CSS backgrounds
// on each track (decision 17A): at 31 days x 3 shifts x a few dozen machines,
// one element per grid cell is thousands of empty nodes whose only job is to
// draw a line.
//
// AT MOST 31 DAYS, and a longer range is CLIPPED WITH A BANNER, never silently.
// The server refuses a wider window, so the clip happens before the request;
// `ganttWindow` hands back the flag with the dates so the banner cannot be
// forgotten. The server's own `truncated` gets a banner of its own.
//
// THE GRID IS ALWAYS DRAWN — the day and shift header survive an empty plan,
// a loading plan and a failed one, for the reason calendar-view.tsx gives: an
// empty chart is a chart with empty days, and a failed fetch drawn as empty is
// the dangerous direction, so that one gets a loud banner.
//
// A BAR OPENS THE JOB'S READ-ONLY DETAIL on the bar's first day
// (`onSelectBar`), never the edit form.

// Every size in rem, so the chart scales with the user's font size.
const SLOT_REM = 2.5;
const DAY_REM = SLOT_REM * SHIFTS_PER_DAY;
const LINE_COL_REM = 12;
const MACHINE_COL_REM = 9;
const LEFT_REM = LINE_COL_REM + MACHINE_COL_REM;
const LANE_REM = 1.75;
const LANE_PAD_REM = 0.25;

// Shift lines every slot, and a stronger line every day. Two gradient layers on
// one element, so the grid costs nothing per cell.
const GRID_STYLE: CSSProperties = {
  backgroundImage: [
    `repeating-linear-gradient(to right, transparent 0 calc(${DAY_REM}rem - 1px), var(--border) calc(${DAY_REM}rem - 1px) ${DAY_REM}rem)`,
    `repeating-linear-gradient(to right, transparent 0 calc(${SLOT_REM}rem - 1px), color-mix(in oklab, var(--border) 45%, transparent) calc(${SLOT_REM}rem - 1px) ${SLOT_REM}rem)`,
  ].join(", "),
};

type GanttViewProps = {
  range: DateRange | undefined;
  filters: { workCenterIds: number[]; workUnitIds: number[] };
  timeZone: string;
  // A bar was clicked: open that job's READ-ONLY detail on the bar's first day.
  onSelectBar?: (jobId: number, date: string) => void;
};

function GanttView({ range, filters, timeZone, onSelectBar }: GanttViewProps) {
  const { t } = useTranslation("jobs");
  const today = todayIn(timeZone);
  const window = ganttWindow(range, today);
  const query = usePlanItems({ from: window.from, to: window.to, ...filters });

  // Not memoised by hand: the React Compiler (vite.config.ts) does it, and a
  // hand-written dependency on `window.days` — a fresh array every render —
  // would memoise nothing while looking as if it did.
  const lines = buildGantt(query.data?.items ?? [], window.days);

  const trackWidth = window.days.length * DAY_REM;

  return (
    <div className="space-y-3">
      {window.clipped ? (
        <Alert>
          <AlertTriangleIcon />
          <AlertTitle>{t("gantt.firstDays", { count: GANTT_MAX_DAYS })}</AlertTitle>
          <AlertDescription>
            {t("gantt.maxDays", {
              count: GANTT_MAX_DAYS,
              range: formatCivilRange(window.days[0]!, window.days.at(-1)!),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {query.data?.truncated ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{t("gantt.partial")}</AlertTitle>
          <AlertDescription>{t("gantt.truncated")}</AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>{t("gantt.loadError")}</AlertTitle>
          <AlertDescription>
            {t("gantt.emptyBecauseError")} {errorMessage(query.error, "")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        className={cn(
          "overflow-x-auto rounded-lg border",
          query.data === undefined && "opacity-60",
        )}
        aria-busy={query.data === undefined}
      >
        <div
          role="group"
          aria-label={t("gantt.aria")}
          style={{ width: `${LEFT_REM + trackWidth}rem` }}
        >
          <GanttHeader days={window.days} today={today} />

          {lines.length === 0 ? (
            <div className="flex border-t">
              <div
                className="bg-background text-muted-foreground sticky left-0 z-10 flex shrink-0 items-center border-r px-3 py-6 text-sm"
                style={{ width: `${LEFT_REM}rem` }}
              >
                {query.data === undefined && !query.isError
                  ? t("common.loading")
                  : t("gantt.nothing")}
              </div>
              <div className="shrink-0" style={{ ...GRID_STYLE, width: `${trackWidth}rem` }} />
            </div>
          ) : (
            lines.map((line) => (
              <LineGroup
                key={line.workCenterId}
                line={line}
                trackWidth={trackWidth}
                days={window.days}
                onSelectBar={onSelectBar}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function GanttHeader({ days, today }: { days: string[]; today: string }) {
  const { t } = useTranslation("jobs");
  return (
    <div className="bg-muted/40 flex">
      <div
        className="bg-muted sticky left-0 z-20 flex shrink-0 items-center border-r px-3 text-sm font-semibold"
        style={{ width: `${LEFT_REM}rem` }}
      >
        {t("gantt.production")}
      </div>
      {days.map((date, i) => (
        <div
          key={date}
          className={cn("shrink-0 border-r last:border-r-0", date === today && "bg-primary/5")}
          style={{ width: `${DAY_REM}rem` }}
          title={date}
        >
          <div className="px-1 pt-1.5 text-center text-xs font-medium whitespace-nowrap">
            {WEEKDAY_SHORT[dayOfWeek(date)]} {dayOfMonth(date)}
            {/* The month where it changes, and on the first column — a 31-day
                window crosses one, and "Thu 1" alone does not say which. */}
            {i === 0 || dayOfMonth(date) === 1 ? (
              <span className="text-muted-foreground"> {MONTH_NAMES[month(date) - 1]}</span>
            ) : null}
          </div>
          <div className="text-muted-foreground flex text-[11px] tabular-nums">
            {SHIFTS.map((shift) => (
              <span
                key={shift}
                className="py-1 text-center"
                style={{ width: `${SLOT_REM}rem` }}
                aria-label={t("calendar.shiftN", { n: shift })}
              >
                {shift}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LineGroup({
  line,
  trackWidth,
  days,
  onSelectBar,
}: {
  line: GanttLineGroup;
  trackWidth: number;
  days: string[];
  onSelectBar: ((jobId: number, date: string) => void) | undefined;
}) {
  return (
    <div className="flex border-t">
      {/* The line cell spans its machines by being their flex sibling — it
          stretches to the column's height without a rowSpan to keep in step. */}
      <div
        className="bg-background sticky left-0 z-10 shrink-0 space-y-1 border-r px-3 py-2"
        style={{ width: `${LINE_COL_REM}rem` }}
      >
        <div className="truncate text-sm font-medium">{line.workCenterName}</div>
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {line.totals.map((t) => (
            <li key={`${t.productId}-${t.unit ?? ""}`} className="truncate tabular-nums">
              {formatSkuQuantity(t.productName, t.total, t.unit)}
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        {line.machines.map((machine) => (
          <div key={machine.workUnitId} className="flex border-t first:border-t-0">
            <div
              className="bg-background sticky z-10 flex shrink-0 items-center border-r px-3 text-sm"
              style={{ left: `${LINE_COL_REM}rem`, width: `${MACHINE_COL_REM}rem` }}
            >
              <span className="truncate">{machine.workUnitName}</span>
            </div>
            <div
              className="relative shrink-0"
              style={{
                ...GRID_STYLE,
                width: `${trackWidth}rem`,
                height: `${machine.laneCount * LANE_REM + 2 * LANE_PAD_REM}rem`,
              }}
            >
              {machine.bars.map((bar) => (
                <Bar key={bar.key} bar={bar} days={days} onSelect={onSelectBar} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({
  bar,
  days,
  onSelect,
}: {
  bar: GanttBar;
  days: string[];
  onSelect: ((jobId: number, date: string) => void) | undefined;
}) {
  const { t } = useTranslation("jobs");
  const label = formatSkuQuantity(bar.productName, bar.target, bar.unit);
  const firstDay = days[Math.floor(bar.startSlot / SHIFTS_PER_DAY)]!;
  const lastDay = days[Math.floor((bar.endSlot - 1) / SHIFTS_PER_DAY)]!;
  const title = t("gantt.barTitle", {
    id: bar.jobId,
    label,
    range: formatCivilRange(firstDay, lastDay),
    from: (bar.startSlot % SHIFTS_PER_DAY) + 1,
    to: ((bar.endSlot - 1) % SHIFTS_PER_DAY) + 1,
  });

  // A button that opens the job's read-only detail on the bar's FIRST day — the
  // day a planner would look for it under. Plain without a handler (tests).
  const Shell = onSelect === undefined ? "div" : "button";
  const shell =
    onSelect === undefined
      ? { role: "note" }
      : { type: "button" as const, onClick: () => onSelect(bar.jobId, firstDay) };

  return (
    <Shell
      {...shell}
      aria-label={title}
      title={title}
      className={cn(
        "bg-event-fill text-event-ink border-event absolute truncate rounded border-l-2 px-1.5 text-left text-xs leading-6",
        onSelect !== undefined &&
          "focus-visible:ring-ring cursor-pointer outline-none hover:brightness-95 focus-visible:ring-2",
      )}
      style={{
        left: `${bar.startSlot * SLOT_REM}rem`,
        width: `${(bar.endSlot - bar.startSlot) * SLOT_REM}rem`,
        top: `${LANE_PAD_REM + bar.lane * LANE_REM}rem`,
        height: `${LANE_REM - 0.25}rem`,
      }}
    >
      {label}
    </Shell>
  );
}

export { GanttView };
