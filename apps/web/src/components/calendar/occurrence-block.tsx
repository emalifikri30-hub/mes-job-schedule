import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  formatClockRange,
  formatCompactTime,
  formatOccurrenceTime,
} from "@/lib/layout-occurrences";

import type { TFunction } from "i18next";
import type { ShiftBlock } from "@/lib/types";
import type { CSSProperties } from "react";

// ONE SHIFT BLOCK — a (job, business date, shift) — IN THE TWO SHAPES A
// CALENDAR HAS ROOM FOR.
//
//   ROW                         a DOT + TIME + LABEL, no fill
//   ● 7am  S1 · 3 lines         for a month cell or a short slot. The moment
//                               leads, because that is what a row is read for.
//
//   BLOCK                       a tinted block with a solid accent edge
//   ┃ Shift 1                   for a time-grid slot with room to spare. The
//   ┃ 7am – 3pm                 edge is what keeps overlapping jobs legible as
//   ┃ 3 lines · 5 mach · 4 SKU  separate columns.
//
// COUNTS, NOT TARGETS (decision 1A). A block is one shift of one job, and a
// row's target is per DAY across every ticked shift — dividing it by three
// would print a number nobody planned. Targets live on the Gantt, where a bar
// is a run of shifts and the rule for which bar carries a row's target is
// stated (lib/gantt-bars.ts).
//
// A BUTTON THAT OPENS THE READ-ONLY JOB DETAIL, on this block's business date
// (components/job/job-detail-sheet.tsx) — never the edit dialog, which would put
// every glance one keystroke from rewriting a whole plan. Without an `onSelect`
// (a renderer test) it is a plain element, because a block that looks clickable
// and does nothing reads as broken. The tooltip carries everything the compact
// shapes drop either way.
//
// THE DOT IS THE ONLY COLOURED THING IN THE ROW SHAPE. The time and the label
// wear ordinary text tokens: a coloured mark carries identity, and text in the
// series colour is what the palette rules forbid (index.css).
//
// `variant` is about the SPACE AVAILABLE, not about which view is asking. A
// `view` prop would be a flag encoding "who is rendering me", which is how the
// Month view ends up showing something the Week view does not for no
// recoverable reason.

type OccurrenceBlockProps = {
  occurrence: ShiftBlock;
  // "row"   — one line, for a month cell or a short time-grid block
  // "block" — the taller form, for a time-grid block with room to spare
  variant?: "row" | "block";
  className?: string;
  style?: CSSProperties;
  onSelect?: (block: ShiftBlock) => void;
};

// "3 lines · 5 machines · 4 SKUs". One summary, reused by the block and the
// agenda, so the two can never count differently.
function scopeLabel(block: ShiftBlock, t: TFunction<"jobs">): string {
  return [
    t("calendar.linesCount", { count: block.lineCount }),
    t("calendar.machinesCount", { count: block.machineCount }),
    t("calendar.skusCount", { count: block.skuCount }),
  ].join(" · ");
}

// Everything, in words — the tooltip, and the accessible name of a block that
// has no other interactive affordance to hang one on.
function blockTitle(block: ShiftBlock, t: TFunction<"jobs">): string {
  return [
    t("calendar.job", { id: block.jobId }),
    `${t("calendar.shiftN", { n: block.shift })} (${formatClockRange(block)})`,
    block.lineNames.join(", "),
    scopeLabel(block, t),
  ]
    .filter(Boolean)
    .join(" · ");
}

function OccurrenceBlock({
  occurrence,
  variant = "row",
  className,
  style,
  onSelect,
}: OccurrenceBlockProps) {
  const { t } = useTranslation("jobs");
  const title = blockTitle(occurrence, t);
  const interactive = onSelect !== undefined;
  const shared = cn(
    "w-full truncate rounded text-left text-xs",
    interactive && "focus-visible:ring-ring cursor-pointer outline-none focus-visible:ring-2",
    className,
  );
  // One element either way, so the two shapes below differ only in content.
  const Shell = interactive ? "button" : "div";
  const shell = interactive
    ? { type: "button" as const, onClick: () => onSelect(occurrence) }
    : { role: "note" };

  if (variant === "row") {
    return (
      <Shell
        {...shell}
        title={title}
        aria-label={title}
        style={style}
        className={cn(
          shared,
          "flex items-center gap-1.5 px-1 py-0.5 leading-5",
          interactive && "hover:bg-accent",
        )}
      >
        {/* `shrink-0` because a long label must eat its own width, not the mark
            that identifies the row as a shift. */}
        <span aria-hidden className="bg-event size-2 shrink-0 rounded-full" />
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {formatCompactTime(occurrence)}
        </span>
        <span className="truncate">
          S{occurrence.shift} · {t("calendar.linesCount", { count: occurrence.lineCount })}
        </span>
      </Shell>
    );
  }

  return (
    <Shell
      {...shell}
      title={title}
      aria-label={title}
      style={style}
      className={cn(
        shared,
        "bg-event-fill text-event-ink border-event block h-full overflow-hidden border-l-2 px-1.5 py-1",
        interactive && "hover:brightness-95",
      )}
    >
      <span className="block truncate font-medium">
        {t("calendar.shiftN", { n: occurrence.shift })}
      </span>
      <span className="block truncate opacity-80">{formatOccurrenceTime(occurrence)}</span>
      <span className="block truncate opacity-80">{scopeLabel(occurrence, t)}</span>
    </Shell>
  );
}

export { OccurrenceBlock, blockTitle, scopeLabel };
