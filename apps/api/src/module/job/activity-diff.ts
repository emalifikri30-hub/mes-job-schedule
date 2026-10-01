import type {
  ActivityChange,
  Job,
  JobPerson,
  JobRole,
  JobWrite,
  OvertimeUnit,
  PlanRow,
} from "./job.js";

// WHAT CHANGED, IN WORDS.
//
// WHY THE DIFF IS COMPUTED AND FORMATTED ON THE SERVER, AT WRITE TIME
//
// The alternative is storing both versions of the job and rendering a diff in the
// browser. That is worse in the way that matters for an audit trail: it makes the
// log's legibility depend on today's rendering code. What gets stored here is a
// sentence — "Roll yield: 95% → 97%" — which stays true no matter what the UI
// becomes. It is also why `from`/`to` are strings: a RECORD OF WHAT HAPPENED, not
// data to compute with.
//
// THE PLAN IS SUMMARISED, NOT DIFFED ROW BY ROW. A re-upload replaces the plan
// wholesale (that is how the dialog edits one), and a 560-row plan diffed cell by
// cell is a log entry nobody reads. The entry says the plan changed and how big it
// is now; the rows themselves are on the job.
//
// FIELDS NOT DIFFED, and each absence is deliberate:
//
//   time_zone   derived from the first machine, so it only moves as a consequence
//               of the plan moving — which is already a line.
//   created_*   immutable by construction (the repository never updates them).

const EM_DASH = "—";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-10-01" -> "01 Oct 2026". Read from the string, never through `Date`,
// which would parse it at UTC midnight and print it in the process's zone.
function civilLabel(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day} ${MONTHS[Number(month) - 1]} ${year}`;
}

function rangeLabel(startDate: string, endDate: string): string {
  return startDate === endDate
    ? civilLabel(startDate)
    : `${civilLabel(startDate)} – ${civilLabel(endDate)}`;
}

// What the activity feed calls a job. The id is what makes it findable; the
// range is what makes it recognisable. FROZEN onto the log row, so a job whose
// range is later edited keeps its old label on its old entries — which is
// accurate: that is what it was called when the entry was written.
function jobLabel(jobId: number, startDate: string, endDate: string): string {
  return `Job #${jobId} · ${rangeLabel(startDate, endDate)}`;
}

function amount(value: number | null, suffix = ""): string {
  return value === null ? EM_DASH : `${value}${suffix}`;
}

const OVERTIME_UNIT: Record<OvertimeUnit, string> = {
  HOUR_PER_GROUP: "h/group",
  PERSON_PER_HOUR: "person/hour",
};

function overtime(value: number | null, unit: OvertimeUnit | null): string {
  return value === null || unit === null ? EM_DASH : `${value} ${OVERTIME_UNIT[unit]}`;
}

function text(value: string | null): string {
  return value === null || value === "" ? EM_DASH : value;
}

// SORTED, so re-picking the same people in a different order is not a change.
function people(list: JobPerson[], role: JobRole): string {
  const names = list
    .filter((person) => person.role === role)
    .map((person) => person.userName)
    .sort((a, b) => a.localeCompare(b));
  return names.length === 0 ? EM_DASH : names.join(", ");
}

// A canonical fingerprint of a plan, order-independent, so a re-upload of the
// same CSV with its rows shuffled is not reported as a change.
function planFingerprint(plan: PlanRow[]): string {
  return plan
    .map((row) =>
      [
        row.planDate,
        row.workUnitId,
        row.productId,
        row.target,
        row.uomCode ?? "",
        row.shift1 ? 1 : 0,
        row.shift2 ? 1 : 0,
        row.shift3 ? 1 : 0,
      ].join("|"),
    )
    .sort()
    .join("\n");
}

function planSummary(plan: PlanRow[]): string {
  const lines = new Set(plan.map((row) => row.workCenterId)).size;
  const machines = new Set(plan.map((row) => row.workUnitId)).size;
  return `${plan.length} rows · ${lines} ${lines === 1 ? "line" : "lines"} · ${machines} ${
    machines === 1 ? "machine" : "machines"
  }`;
}

// Compares the stored job to the write about to replace it.
//
// Returns an EMPTY ARRAY when nothing moved, and the caller decides what that
// means — the service skips the audit row, because "somebody pressed Save and
// changed nothing" is not an event worth a line.
function diffJob(previous: Job, next: JobWrite): ActivityChange[] {
  const pairs: [string, string, string][] = [
    [
      "Date",
      rangeLabel(previous.startDate, previous.endDate),
      rangeLabel(next.startDate, next.endDate),
    ],
    ["Roll yield", amount(previous.rollYield, "%"), amount(next.rollYield, "%")],
    ["Bag yield", amount(previous.bagYield, "%"), amount(next.bagYield, "%")],
    ["WD today", amount(previous.wdToday, "%"), amount(next.wdToday, "%")],
    ["RW personel", amount(previous.rwPersonnel), amount(next.rwPersonnel)],
    ["TW personel", amount(previous.twPersonnel), amount(next.twPersonnel)],
    [
      "Overtime/shift",
      overtime(previous.overtime, previous.overtimeUnit),
      overtime(next.overtime, next.overtimeUnit),
    ],
    ["Notes", text(previous.notes), text(next.notes)],
    ["Managers", people(previous.people, "MANAGER"), people(next.people, "MANAGER")],
    ["Foreman", people(previous.people, "FOREMAN"), people(next.people, "FOREMAN")],
    ["AFA", people(previous.people, "AFA"), people(next.people, "AFA")],
  ];

  const changes = pairs
    .filter(([, from, to]) => from !== to)
    .map(([field, from, to]) => ({ field, from, to }));

  // The plan is one line, and only when its CONTENT moved. Two plans of the same
  // size can differ, so the summary alone cannot decide it; the fingerprint does,
  // and the words say which kind of change it was.
  if (planFingerprint(previous.plan) !== planFingerprint(next.plan)) {
    const from = planSummary(previous.plan);
    const to = planSummary(next.plan);
    changes.push({ field: "Plan", from, to: from === to ? `${to} (contents replaced)` : to });
  }

  return changes;
}

export { EM_DASH, civilLabel, diffJob, jobLabel, planFingerprint, planSummary, rangeLabel };
