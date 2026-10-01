import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { MONTH_NAMES, dayOfWeek, dayOfMonth, month, todayIn } from "@/lib/civil-date";
import { blockKey, formatOccurrenceTime, groupByDate } from "@/lib/layout-occurrences";
import { blockTitle, scopeLabel } from "@/components/calendar/occurrence-block";

import type { ReactNode } from "react";
import type { ShiftBlock } from "@/lib/types";

// THE SCHEDULE VIEW — a flat, chronological list.
//
// The third of the three renderers, and the only one that draws no grid at all.
// It exists for the question the grids answer badly: "what is coming up", across
// weeks, without paging. That is why it OMITS EMPTY DAYS — a grid has to draw
// every cell, a list does not, and ninety rows of "nothing scheduled" would bury
// the six that matter.

type AgendaListProps = {
  occurrences: ShiftBlock[];
  timeZone: string;
  onSelect?: (block: ShiftBlock) => void;
};

// Grouped by BUSINESS date, like the month grid: an agenda row reads "Friday's
// shift 3", and its 23:00 – 07:00 range already says it runs past midnight.
function AgendaList({ occurrences, timeZone, onSelect }: AgendaListProps) {
  const { t } = useTranslation("jobs");
  const groups = useMemo(() => groupByDate(occurrences), [occurrences]);
  const today = todayIn(timeZone);
  const weekdayNames = t("calendar.weekdaysLong", { returnObjects: true }) as string[];

  if (groups.length === 0) {
    return (
      <div className="text-muted-foreground rounded-lg border p-12 text-center text-sm">
        {t("calendar.nothingScheduled")}
      </div>
    );
  }

  return (
    <div className="divide-y overflow-hidden rounded-lg border">
      {groups.map((group) => (
        <div key={group.date} className="flex gap-4 p-3 sm:p-4">
          {/* The date rail is fixed-width so every row's text starts at the
              same x — a list whose left edge moves per row is much harder to
              scan than one that does not. */}
          <div className="w-20 shrink-0 sm:w-28">
            <div className={cn("text-lg font-semibold", group.date === today && "text-primary")}>
              {dayOfMonth(group.date)} {MONTH_NAMES[month(group.date) - 1]}
            </div>
            <div className="text-muted-foreground text-xs">
              {group.date === today ? t("common.today") : weekdayNames[dayOfWeek(group.date)]}
            </div>
          </div>

          <ul className="min-w-0 flex-1 space-y-1">
            {[...group.items]
              .sort((a, b) =>
                a.startsAt === b.startsAt ? a.jobId - b.jobId : a.startsAt < b.startsAt ? -1 : 1,
              )
              .map((o) => (
                // A button inside the list item when the row opens the job's
                // read-only detail — see occurrence-block.tsx.
                <li key={blockKey(o)}>
                  <AgendaRow block={o} onSelect={onSelect}>
                    {/* The FULL range here, unlike the month cells: an agenda row
                      has the width for it, and "how long is this" is the
                      question the Schedule view is read for. */}
                    <span className="text-muted-foreground flex w-28 shrink-0 items-center gap-1.5 text-xs tabular-nums sm:w-32">
                      <span className="bg-event size-1.5 shrink-0 rounded-full" aria-hidden />
                      {formatOccurrenceTime(o)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {t("calendar.shiftN", { n: o.shift })} ·{" "}
                        {t("calendar.job", { id: o.jobId })}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {o.lineNames.join(", ")} · {scopeLabel(o, t)}
                      </span>
                    </span>
                  </AgendaRow>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// The row's shell: a button when there is somewhere to go, a plain block when
// there is not (a renderer test with no handler).
function AgendaRow({
  block,
  onSelect,
  children,
}: {
  block: ShiftBlock;
  onSelect: ((block: ShiftBlock) => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation("jobs");
  const title = blockTitle(block, t);
  const className = "flex w-full items-start gap-3 rounded-md px-2 py-1.5 text-left";
  if (onSelect === undefined) {
    return (
      <div title={title} className={className}>
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={() => onSelect(block)}
      className={cn(
        className,
        "hover:bg-accent focus-visible:ring-ring outline-none focus-visible:ring-2",
      )}
    >
      {children}
    </button>
  );
}

export { AgendaList };
