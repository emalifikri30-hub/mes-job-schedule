// Domain types for a production JOB and its plan.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE VOCABULARY
// ─────────────────────────────────────────────────────────────────────────────
//
//   JOB        one row in job_schedule.jobs — a date range plus the header a
//              planner fills in (yields, personnel, overtime, notes) and the
//              people responsible (job_schedule.job_people).
//   PLAN ROW   one row in job_schedule.job_plan_items — ONE LINE OF THE CSV:
//              on `planDate`, run `product` on `workUnit` (a machine on
//              `workCenter`, a line) for the ticked shifts, aiming at `target`.
//   SHIFT      1, 2 or 3. Hardcoded boundaries in shared/shift.ts. A row's
//              `planDate` is the BUSINESS date, so shift 3 of Friday runs from
//              Friday 23:00 to Saturday 07:00.
//
// `target` is PER ROW — the day's quantity for that machine and SKU across every
// shift ticked on it — and is NOT divided between shifts anywhere in this
// codebase. Splitting it evenly would invent a number nobody planned.
//
// ITS UNIT is the machine's FINISH-GOOD unit: the uom of that machine's
// `good_output` count point in mes-master-data, read once at write time and
// frozen here. The same output-side unit mes-oee-monitor reports a line's
// `good_out` in (its contract §16.4), which is what will make plan-vs-actual
// comparable. NULL when the machine has no good_output count point — rendered as
// a bare number, never with a guessed unit.

type ShiftNumber = 1 | 2 | 3;

type JobRole = "MANAGER" | "FOREMAN" | "AFA";

type OvertimeUnit = "HOUR_PER_GROUP" | "PERSON_PER_HOUR";

// A person named on a job. The name is FROZEN at write time for the same reason
// every master-data name in this schema is: a job must keep saying who ran it
// after that person is renamed or leaves the realm.
type JobPerson = {
  role: JobRole;
  userId: string;
  userName: string;
};

type PlanRow = {
  planDate: string;
  workCenterId: number;
  workCenterName: string;
  workUnitId: number;
  workUnitName: string;
  productId: number;
  productCode: string;
  productName: string;
  target: number;
  uomCode: string | null;
  uomName: string | null;
  shift1: boolean;
  shift2: boolean;
  shift3: boolean;
};

type JobHeader = {
  startDate: string;
  endDate: string;
  rollYield: number | null;
  bagYield: number | null;
  wdToday: number | null;
  rwPersonnel: number | null;
  twPersonnel: number | null;
  overtime: number | null;
  overtimeUnit: OvertimeUnit | null;
  notes: string | null;
};

// One job, as the edit dialog loads it.
type Job = JobHeader & {
  id: number;
  timeZone: string;
  people: JobPerson[];
  plan: PlanRow[];
  createdById: string;
  createdByName: string | null;
  createdAt: string;
  updatedById: string | null;
  updatedByName: string | null;
  updatedAt: string | null;
};

// One row of the Table view. Counts rather than the plan itself — a page of 25
// jobs must not carry 25 x 560 plan rows to draw four columns.
type JobSummary = JobHeader & {
  id: number;
  lineNames: string[];
  planRowCount: number;
  createdById: string;
  createdByName: string | null;
  createdAt: string;
};

// A plan row on the Gantt, tagged with its job so two jobs are never merged
// into one bar.
type PlanItem = PlanRow & {
  jobId: number;
};

// One Calendar block: a (job, business date, shift). Shaped like the
// occurrence the calendar renderers already draw — `occurrenceDate` is the
// business date, `startsAt`/`endsAt` are INSTANTS built on the server from the
// wall-clock shift boundaries in the plan's zone.
type ShiftBlock = {
  jobId: number;
  occurrenceDate: string;
  shift: ShiftNumber;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  lineNames: string[];
  lineCount: number;
  machineCount: number;
  skuCount: number;
};

// The window reads' filters. `from`/`to` are HALF-OPEN civil dates, as every
// window in this codebase is.
type PlanWindowQuery = {
  from: string;
  to: string;
  workCenterIds: number[];
  workUnitIds: number[];
};

// The Table's range is OPTIONAL — no range is "every job, newest first".
type JobListQuery = Omit<PlanWindowQuery, "from" | "to"> & {
  from?: string;
  to?: string;
  page: number;
  size: number;
};

// ---------------------------------------------------------------------------
// The CSV, as it crosses the wire
// ---------------------------------------------------------------------------

// ONE CSV DATA ROW, AS TEXT. The browser checks syntax only (columns, date
// format, a number in `target`, `v` or blank in the shift cells) and sends these
// cells; RESOLVING them — which line, which machine, which product, which unit —
// is the server's, because it needs master data and because a browser is not a
// source of truth about master data.
//
// `row` is the 1-based DATA row number (header excluded), so an error lines up
// with what the planner sees in a spreadsheet once the header is discounted.
type RawPlanRow = {
  row: number;
  date: string;
  line: string;
  sku: string;
  skuCode: string;
  target: number;
  machine: string;
  shift1: boolean;
  shift2: boolean;
  shift3: boolean;
};

type PlanIssue = {
  // 0 when the issue is about the job as a whole rather than one row (a person
  // not holding the role, an empty plan).
  row: number;
  field: string;
  message: string;
};

// What preview answers, and what a failed save answers too — so the dialog has
// ONE shape to render whether the failure was found before or at Save.
type PlanPreview = {
  rows: PlanRow[];
  issues: PlanIssue[];
  // Rows with no shift ticked. Skipped, not errors: that is how a planner says
  // "not this SKU on this machine today" in a template that lists every pair.
  ignoredRows: number;
};

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

type ActivityAction = "CREATED" | "UPDATED" | "DELETED";

// ONE FIELD THAT CHANGED, already worded — see activity-diff.ts.
type ActivityChange = {
  field: string;
  from: string;
  to: string;
};

type ActivityEntry = {
  id: number;
  // NULL once the job has been deleted — the row survives it deliberately, see
  // the ON DELETE SET NULL note in 0002_activity_log.sql.
  jobId: number | null;
  jobLabel: string;
  action: ActivityAction;
  actorId: string;
  actorName: string | null;
  at: string;
  // NULL for CREATED and DELETED, where there is no before-and-after.
  changes: ActivityChange[] | null;
};

type ActivityWrite = Omit<ActivityEntry, "id" | "at">;

// What a create/update writes, once the service has resolved everything.
type JobWrite = JobHeader & {
  timeZone: string;
  people: JobPerson[];
  plan: PlanRow[];
  actorId: string;
  actorName: string | null;
};

export type {
  ActivityAction,
  ActivityChange,
  ActivityEntry,
  ActivityWrite,
  Job,
  JobHeader,
  JobListQuery,
  JobPerson,
  JobRole,
  JobSummary,
  JobWrite,
  OvertimeUnit,
  PlanIssue,
  PlanItem,
  PlanPreview,
  PlanRow,
  PlanWindowQuery,
  RawPlanRow,
  ShiftBlock,
  ShiftNumber,
};
