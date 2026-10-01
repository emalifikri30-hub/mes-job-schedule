import { AlertTriangleIcon, ChevronDownIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { errorMessage } from "@/lib/api";
import { formatCivilLong, formatCivilRange } from "@/lib/civil-date";
import { formatQuantity, formatSkuQuantity } from "@/lib/gantt-bars";
import { groupPlanByDate, planOverview } from "@/lib/job-detail";
import { totalsByLineAndMachine } from "@/lib/plan-summary";
import { useJob } from "@/lib/queries";
import { SHIFTS, SHIFT_HOURS } from "@/lib/shift";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";

import type { ReactNode } from "react";
import type { SkuTotal } from "@/lib/gantt-bars";
import type { DayDetail, DetailRow, LineDetail } from "@/lib/job-detail";
import type { Job, JobPerson, JobRole, OvertimeUnit, ShiftNumber } from "@/lib/types";

// THE JOB DETAIL — READ-ONLY, and a SHEET rather than the edit dialog.
//
// Looking is far more common than changing, and an edit here replaces a whole
// plan; a click that landed in a form would put every glance one keystroke from
// re-planning a job. Edit is one deliberate button away, and hands off to the
// same dialog the Table's pencil opens.
//
//   ┌ Job #12 · Thu, 1 Oct 2026 – Sat, 10 Oct 2026 ─────────────── [Edit] ┐
//   │ 10 days   3 lines   12 machines   8 SKUs            ← the plan, counted │
//   │ Roll ▰▰▰▰▰▱ 95%  Bag ▰▰▰▰▱ 88%  WD ▰▰▰▱ 70%          ← meters (0–100)  │
//   │ RW 4 person/shift  TW 2 person/shift  OT 3 h/group  ← plain figures   │
//   │ Managers · Foreman · AFA                              ← who            │
//   │ Totals across the job   (collapsed)                                    │
//   │ ▾ Thu, 1 Oct 2026   [1][2][3]  3 lines · 12 machines · 8 SKUs         │
//   │     Line 1                         SKU A · 400 CTN  SKU B · 100 CTN   │
//   │       Packer N   SKU A  [1][2][3]  ██████████  200 CTN                │
//   │ ▸ Fri, 2 Oct 2026 …                                                   │
//   └────────────────────────────────────────────────────────────────────────┘
//
// GROUPED BY DATE because a job is a date RANGE (the Table prints "01 Oct – 10
// Oct") and a plan is checked day by day. Grouping, totals and bar scaling are
// the pure lib/job-detail.ts; this file only lays them out.
//
// FORM FOLLOWS THE NUMBER'S JOB (the dataviz rules, not taste):
//
//   · the three yields are RATIOS AGAINST A FIXED LIMIT (100%), so each is a
//     meter — one hue on a same-hue track — and never a bar chart of three bars;
//   · headcounts and overtime are single figures with no scale, so they are
//     plain stat tiles with their unit in words;
//   · a plan row's target is MAGNITUDE, so it gets a thin bar in the one event
//     hue, scaled within its (day, line, unit) — see job-detail.ts for why that
//     box — and always the number beside it: the bar is for comparing at a
//     glance, the number is what gets read.
//
// ONE HUE THROUGHOUT (`--event`, validated in index.css). Nothing on this sheet
// is categorical — lines and SKUs are unbounded sets, and identity is carried in
// TEXT — so there is no second colour to introduce. Text never wears the event
// colour; it stays in foreground / muted ink beside the marks.
//
// NULL IS "NOT STATED", NEVER 0. A yield nobody filled in is a dash, not an empty
// meter — an empty meter reads as "0% yield", which is a claim about the plant.

function overtimeUnitLabel(unit: OvertimeUnit, t: (key: string) => string): string {
  switch (unit) {
    case "HOUR_PER_GROUP":
      return t("jobs.hourPerGroup");
    case "PERSON_PER_HOUR":
      return t("jobs.personPerHour");
    default: {
      const _exhaustive: never = unit;
      return _exhaustive;
    }
  }
}

type JobDetailSheetProps = {
  jobId: number | undefined;
  // The business date to open on — the day of the block or bar that was clicked.
  // Undefined (the Table's Detail) opens the first day.
  focusDate?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (jobId: number) => void;
};

function JobDetailSheet({ jobId, focusDate, open, onOpenChange, onEdit }: JobDetailSheetProps) {
  const { t } = useTranslation("jobs");
  // Gated on `open` as well as the id: the sheet stays mounted while closed, and
  // a job fetched for a sheet nobody is looking at is a request for nothing.
  const query = useJob(open ? jobId : undefined);
  const job = query.data;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <SheetHeader className="bg-background sticky top-0 z-10 border-b pr-12">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <SheetTitle>
                {jobId === undefined ? t("jobs.job") : t("calendar.job", { id: jobId })}
              </SheetTitle>
              <SheetDescription>
                {job === undefined
                  ? t("common.loading")
                  : formatCivilRange(job.startDate, job.endDate)}
              </SheetDescription>
            </div>
            {job !== undefined ? (
              <Button variant="outline" size="sm" onClick={() => onEdit(job.id)}>
                <PencilIcon />
                {t("common.edit")}
              </Button>
            ) : null}
          </div>
          {job !== undefined ? <Authorship job={job} /> : null}
        </SheetHeader>

        <div className="space-y-6 p-4">
          {/* On DATA first, not on status. A gated query reports "pending"
              forever (the trap AGENTS.md names), and a failed BACKGROUND refetch
              must not swap a job that is already on screen for an error — the
              job is still true; only the refresh failed. So: the job if there is
              one (with a note if its refresh failed), else the error, else the
              skeleton. */}
          {job !== undefined ? (
            <>
              {query.isError ? (
                <Alert>
                  <AlertTriangleIcon />
                  <AlertTitle>{t("jobs.refreshError")}</AlertTitle>
                  <AlertDescription>
                    {t("jobs.showingEarlier")} {errorMessage(query.error, t("jobs.requestFailed"))}
                  </AlertDescription>
                </Alert>
              ) : null}
              {/* Keyed so that opening another job, or the same job from another
                  day's block, starts from THAT day's open state rather than
                  whichever days were expanded last time. */}
              <DetailBody key={`${job.id}|${focusDate ?? ""}`} job={job} focusDate={focusDate} />
            </>
          ) : query.isError ? (
            <Alert variant="destructive">
              <AlertTriangleIcon />
              <AlertTitle>{t("jobs.loadJobError")}</AlertTitle>
              <AlertDescription>
                {errorMessage(query.error, t("jobs.requestFailed"))}
              </AlertDescription>
            </Alert>
          ) : (
            <DetailSkeleton />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Authorship({ job }: { job: Job }) {
  const { t } = useTranslation("jobs");
  const created = t("jobs.createdByWhen", {
    name: job.createdByName ?? job.createdById,
    when: formatInstant(job.createdAt),
  });
  const updated =
    job.updatedAt === null
      ? null
      : t("jobs.updatedByWhen", {
          name: job.updatedByName ?? job.updatedById ?? "—",
          when: formatInstant(job.updatedAt),
        });
  return (
    <p className="text-muted-foreground text-xs">
      {created}
      {updated === null ? null : ` · ${updated}`}
    </p>
  );
}

// An audit instant, in the reader's own locale and zone: it answers "when did
// somebody press Save", which is a moment, not a plant date.
function formatInstant(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function DetailBody({ job, focusDate }: { job: Job; focusDate: string | undefined }) {
  const { t } = useTranslation("jobs");
  const overview = planOverview(job.plan);
  const days = groupPlanByDate(job.plan);
  const overtimeUnit =
    job.overtimeUnit === null ? undefined : overtimeUnitLabel(job.overtimeUnit, t);

  return (
    <>
      <Section title={t("jobs.planGlance")}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Figure label={t("jobs.daysPlanned")} value={String(overview.days)} />
          <Figure label={t("jobs.lines")} value={String(overview.lines)} />
          <Figure label={t("jobs.machines")} value={String(overview.machines)} />
          <Figure
            label={t("jobs.skus")}
            value={String(overview.skus)}
            hint={t("jobs.planRowCount", { count: overview.rows })}
          />
        </div>
      </Section>

      <Section title={t("jobs.parameters")}>
        <div className="grid gap-2 sm:grid-cols-3">
          <Meter label={t("jobs.rollYield")} value={job.rollYield} />
          <Meter label={t("jobs.bagYield")} value={job.bagYield} />
          <Meter label={t("jobs.wdToday")} value={job.wdToday} />
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Figure
            label={t("jobs.rwPersonnel")}
            value={count(job.rwPersonnel)}
            unit={t("jobs.personShift")}
          />
          <Figure
            label={t("jobs.twPersonnel")}
            value={count(job.twPersonnel)}
            unit={t("jobs.personShift")}
          />
          <Figure
            label={t("jobs.overtimeCompact")}
            value={count(job.overtime)}
            unit={overtimeUnit}
          />
        </div>
        {job.notes !== null ? (
          <div className="mt-2 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs">{t("jobs.notes")}</p>
            <p className="mt-1 text-sm whitespace-pre-wrap">{job.notes}</p>
          </div>
        ) : null}
      </Section>

      <Section title={t("jobs.assignedPeople")}>
        <div className="grid gap-2 sm:grid-cols-3">
          {PEOPLE_ROLES.map(({ role, labelKey }) => (
            <PeopleCard
              key={role}
              label={t(labelKey)}
              people={job.people.filter((p) => p.role === role)}
            />
          ))}
        </div>
      </Section>

      <Section title={t("jobs.jobPlan")} aside={<ShiftLegend />}>
        <JobTotals job={job} />
        <DayList days={days} focusDate={focusDate} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Header pieces
// ---------------------------------------------------------------------------

const PEOPLE_ROLES: { role: JobRole; labelKey: string }[] = [
  { role: "MANAGER", labelKey: "jobs.managers" },
  { role: "FOREMAN", labelKey: "jobs.foreman" },
  { role: "AFA", labelKey: "jobs.afa" },
];

const DASH = "—";

function count(value: number | null): string {
  return value === null ? DASH : new Intl.NumberFormat("en-US").format(value);
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// A STAT TILE. The number is the chart: nothing about one figure is clearer as
// a bar.
function Figure({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  const { t } = useTranslation("jobs");
  const stated = value !== DASH;
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {value}
        {stated && unit !== undefined ? (
          <span className="text-muted-foreground ml-1 text-xs font-normal">{unit}</span>
        ) : null}
      </p>
      {!stated ? <p className="text-muted-foreground text-xs">{t("jobs.notStated")}</p> : null}
      {hint !== undefined ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

// A METER: a ratio against a fixed limit (100%), one hue on a track. NULL draws
// no track at all — an empty track would read as 0%.
function Meter({ label, value }: { label: string; value: number | null }) {
  const { t } = useTranslation("jobs");
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value === null ? DASH : `${value}%`}</p>
      </div>
      {value === null ? (
        <p className="text-muted-foreground text-xs">{t("jobs.notStated")}</p>
      ) : (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          className="bg-muted mt-2 h-1.5 overflow-hidden rounded-full"
        >
          <div className="bg-event h-full rounded-full" style={{ width: `${value}%` }} />
        </div>
      )}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

function PeopleCard({ label, people }: { label: string; people: JobPerson[] }) {
  const { t } = useTranslation("jobs");
  return (
    <div className="rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">
        {label}
        <span className="ml-1 tabular-nums">({people.length})</span>
      </p>
      {people.length === 0 ? (
        <p className="text-muted-foreground mt-2 text-sm">{t("jobs.noOneAssigned")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {people.map((person) => (
            <li key={person.userId} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden
                className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
              >
                {initials(person.userName)}
              </span>
              <span className="truncate">{person.userName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// The shift marks' key. Shift marks are one hue too: filled = planned, outlined =
// not. The NUMBER is inside every mark, so a planned shift is never told apart by
// colour alone.
function ShiftLegend() {
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {SHIFTS.map((shift) => (
        <span key={shift} className="inline-flex items-center gap-1">
          <ShiftMark shift={shift} planned />
          {SHIFT_HOURS[shift]}
        </span>
      ))}
    </p>
  );
}

function ShiftMark({ shift, planned }: { shift: ShiftNumber; planned: boolean }) {
  const { t } = useTranslation("jobs");
  const status = planned ? t("jobs.planned") : t("jobs.notPlanned");
  return (
    <span
      role="img"
      aria-label={`${t("calendar.shiftN", { n: shift })} ${status}`}
      title={`${t("calendar.shiftN", { n: shift })} · ${SHIFT_HOURS[shift]} · ${status}`}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded text-[10px] font-semibold tabular-nums",
        planned ? "bg-event-fill text-event-ink" : "text-muted-foreground/60 border border-dashed",
      )}
    >
      {shift}
    </span>
  );
}

function ShiftMarks({ shifts }: { shifts: ShiftNumber[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {SHIFTS.map((shift) => (
        <ShiftMark key={shift} shift={shift} planned={shifts.includes(shift)} />
      ))}
    </span>
  );
}

function rowShifts(row: Pick<DetailRow, "shift1" | "shift2" | "shift3">): ShiftNumber[] {
  return SHIFTS.filter((s) => [row.shift1, row.shift2, row.shift3][s - 1]);
}

// "SKU A · 400 CTN", one chip per SKU per unit. Text tokens, never the event
// colour — the chips are values, not marks.
function TotalChips({ totals }: { totals: SkuTotal[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {totals.map((total) => (
        <span
          key={`${total.productId}|${total.unit ?? ""}`}
          className="bg-muted rounded px-1.5 py-0.5 text-xs tabular-nums"
        >
          {formatSkuQuantity(total.productName, total.total, total.unit)}
        </span>
      ))}
    </span>
  );
}

// THE WHOLE JOB's totals per line and per machine — the same totalsByLineAndMachine
// the Confirm step printed before Save, so the planner reads back exactly what
// they confirmed. Collapsed by default: the per-day breakdown is what a detail is
// opened for, and this is its sum.
function JobTotals({ job }: { job: Job }) {
  const { t } = useTranslation("jobs");
  const lines = totalsByLineAndMachine(job.plan);
  return (
    <Collapsible className="mb-3 rounded-lg border">
      <CollapsibleTrigger className="group hover:bg-accent/50 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium">
        {t("jobs.totals")}
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">
          {lines.map((line) => (
            <div key={line.workCenterId} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{line.workCenterName}</span>
                <TotalChips totals={line.totals} />
              </div>
              <ul className="space-y-1">
                {line.machines.map((machine) => (
                  <li
                    key={machine.workUnitId}
                    className="flex flex-wrap items-center justify-between gap-2 pl-3 text-sm"
                  >
                    <span className="text-muted-foreground">{machine.workUnitName}</span>
                    <TotalChips totals={machine.totals} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DayList({ days, focusDate }: { days: DayDetail[]; focusDate: string | undefined }) {
  const { t } = useTranslation("jobs");
  // WHICH DAYS START OPEN: the clicked day when there is one; otherwise the first.
  // A short job (≤ 3 days) opens entirely — there is nothing to hunt through.
  const initial = new Set<string>(
    days.length <= 3
      ? days.map((d) => d.date)
      : [
          focusDate !== undefined && days.some((d) => d.date === focusDate)
            ? focusDate
            : days[0]!.date,
        ],
  );
  const [openDays, setOpenDays] = useState(initial);
  const allOpen = openDays.size === days.length;

  if (days.length === 0) {
    return <p className="text-muted-foreground text-sm">{t("jobs.noPlanRows")}</p>;
  }

  return (
    <div className="space-y-2">
      {days.length > 1 ? (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpenDays(new Set(allOpen ? [] : days.map((d) => d.date)))}
          >
            {allOpen ? t("jobs.collapseDays") : t("jobs.expandDays")}
          </Button>
        </div>
      ) : null}
      {days.map((day) => (
        <DaySection
          key={day.date}
          day={day}
          open={openDays.has(day.date)}
          onOpenChange={(next) =>
            setOpenDays((prev) => {
              const out = new Set(prev);
              if (next) out.add(day.date);
              else out.delete(day.date);
              return out;
            })
          }
        />
      ))}
    </div>
  );
}

function DaySection({
  day,
  open,
  onOpenChange,
}: {
  day: DayDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("jobs");
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="rounded-lg border">
      <CollapsibleTrigger
        aria-label={t("jobs.dayAria", {
          date: formatCivilLong(day.date),
          lines: t("calendar.linesCount", { count: day.lineCount }),
        })}
        className="group hover:bg-accent/50 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 text-left"
      >
        <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=closed]:-rotate-90" />
        <span className="text-sm font-semibold">{formatCivilLong(day.date)}</span>
        <ShiftMarks shifts={day.shifts} />
        <span className="text-muted-foreground text-xs">
          {t("calendar.linesCount", { count: day.lineCount })} ·{" "}
          {t("calendar.machinesCount", { count: day.machineCount })} ·{" "}
          {t("calendar.skusCount", { count: day.skuCount })}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t p-3">
          {day.lines.map((line) => (
            <LineBlock key={line.workCenterId} line={line} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ONE LINE ON ONE DAY: its total per SKU per unit, then a row per (machine, SKU)
// with the shifts it runs and its target. The machine cell spans its SKUs and
// carries the machine's own total, so "total target per machine" is read where
// the machine is named rather than in a separate row to match up.
function LineBlock({ line }: { line: LineDetail }) {
  const { t } = useTranslation("jobs");
  return (
    <div className="rounded-md border">
      <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{line.workCenterName}</span>
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">{t("jobs.lineTotal")}</span>
          <TotalChips totals={line.totals} />
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {line.workCenterName}: {t("jobs.planCaption")}
          </caption>
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th scope="col" className="px-3 py-1.5 text-left font-normal">
                {t("jobs.machine")}
              </th>
              <th scope="col" className="px-3 py-1.5 text-left font-normal">
                {t("jobs.runningSku")}
              </th>
              <th scope="col" className="px-3 py-1.5 text-left font-normal">
                {t("jobs.shifts")}
              </th>
              <th scope="col" className="px-3 py-1.5 text-right font-normal">
                {t("jobs.target")}
              </th>
            </tr>
          </thead>
          <tbody>
            {line.machines.map((machine) =>
              machine.rows.map((row, index) => (
                <tr
                  key={`${machine.workUnitId}-${row.productId}`}
                  className={cn(index === 0 && "border-t")}
                >
                  {index === 0 ? (
                    <th
                      scope="rowgroup"
                      rowSpan={machine.rows.length}
                      className="px-3 py-1.5 text-left align-top font-normal"
                    >
                      <span className="block font-medium">{machine.workUnitName}</span>
                      {/* Only when it adds something: one SKU's total is its row. */}
                      {machine.rows.length > 1 ? (
                        <span className="text-muted-foreground mt-0.5 block text-xs">
                          {t("jobs.totalPrefix")}{" "}
                          {machine.totals
                            .map((t) => formatSkuQuantity(t.productName, t.total, t.unit))
                            .join(", ")}
                        </span>
                      ) : null}
                    </th>
                  ) : null}
                  <td className="px-3 py-1.5">
                    <span className="block">{row.productName}</span>
                    <span className="text-muted-foreground block text-xs">{row.productCode}</span>
                  </td>
                  <td className="px-3 py-1.5">
                    <ShiftMarks shifts={rowShifts(row)} />
                  </td>
                  <td className="px-3 py-1.5">
                    <TargetCell row={row} lineName={line.workCenterName} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The target as a thin bar and its number. The bar is scaled within its (day,
// line, unit) — job-detail.ts — and the hover says against what, so a full bar
// is never mistaken for "100% of something".
function TargetCell({ row, lineName }: { row: DetailRow; lineName: string }) {
  const { t } = useTranslation("jobs");
  const unit = row.uomCode ?? row.uomName ?? null;
  const value = formatQuantity(row.target, unit);
  const hover = t("jobs.targetHover", {
    product: row.productName,
    machine: row.workUnitName,
    value,
    unit: unit ?? t("jobs.unitLess"),
    line: lineName,
  });
  return (
    <div className="flex items-center justify-end gap-2" title={hover}>
      <div aria-hidden className="bg-muted hidden h-1.5 w-24 overflow-hidden rounded-full sm:block">
        <div
          className="bg-event h-full rounded-full"
          // A visible sliver for a tiny non-zero target: a bar of 0.3px reads as
          // "nothing planned", which is false.
          style={{ width: row.target === 0 ? 0 : `max(${row.share * 100}%, 4px)` }}
        />
      </div>
      <span className="min-w-20 text-right tabular-nums">{value}</span>
    </div>
  );
}

export { JobDetailSheet };
