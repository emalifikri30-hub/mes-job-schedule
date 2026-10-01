// Wire types for everything this app reads and writes.
//
// These are hand-written rather than imported from a workspace package on
// purpose: `web` depends on no `@molca/*` package, which is what lets its CI
// check job skip the build step every other app needs. The server is
// authoritative — this file MIRRORS it (apps/api/src/module/job/job.ts), and a
// mismatch is caught by the API's own zod schemas, not by a shared type.

type Me = {
  sub: string;
  preferredUsername: string;
  email: string;
};

type PageMeta = {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
};

// core-api's WebResponse envelope. Every response is wrapped in it, so a new
// resource needs its own payload type and not its own envelope.
type WebResponse<T> = {
  data: T | null;
  meta?: PageMeta;
  error: string | null;
};

// ---------------------------------------------------------------------------
// master-data catalogues, served through core-api rather than direct
// ---------------------------------------------------------------------------

type AreaSummary = {
  id: number;
  code: string;
  name: string;
};

// A LINE.
type WorkCenterSummary = AreaSummary;

// A MACHINE on a line.
type WorkUnitSummary = AreaSummary;

// A SKU produced on a line. The plan CSV matches on `code` (decision 8A) — a
// product NAME is for the human reading the template, and two SKUs may share one.
type ProductSummary = AreaSummary;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

type JobRole = "MANAGER" | "FOREMAN" | "AFA";

// A member of the realm role a picker lists. `id` is the Keycloak user id — a
// STRING, unlike every master-data id in this file.
type RoleUser = {
  id: string;
  name: string;
};

// A person named on a job, with the name FROZEN at write time so a job keeps
// saying who ran it after that person is renamed or leaves the realm.
type JobPerson = {
  role: JobRole;
  userId: string;
  userName: string;
};

// ---------------------------------------------------------------------------
// Jobs and their plan
// ---------------------------------------------------------------------------

// The calendar tab's six views. `fourDay` is the default — see
// lib/calendar-search.ts.
type CalendarViewMode = "day" | "fourDay" | "week" | "month" | "year" | "schedule";

const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = [
  "day",
  "fourDay",
  "week",
  "month",
  "year",
  "schedule",
];

// The three tabs above the body. Calendar first, and the default.
type ScheduleTab = "calendar" | "table" | "gantt";

const SCHEDULE_TABS: readonly ScheduleTab[] = ["calendar", "table", "gantt"];

type ShiftNumber = 1 | 2 | 3;

type OvertimeUnit = "HOUR_PER_GROUP" | "PERSON_PER_HOUR";

// ONE LINE OF THE PLAN, resolved: on `planDate` (the BUSINESS date — Friday's
// shift 3 runs into Saturday morning), run `product` on `workUnit` for the ticked
// shifts, aiming at `target`.
//
// `target` IS PER ROW — the day's quantity across every ticked shift — and is
// never divided between shifts anywhere in this app. Its unit is the machine's
// FINISH-GOOD unit, frozen at write time; NULL means the machine has no
// good_output count point, and the number is then shown bare rather than with a
// guessed unit.
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
  // Both INCLUSIVE civil dates — a planner's range, not a query window.
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

// One row of the Table tab. Counts rather than the plan itself — a page of 25
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

// ONE CALENDAR BLOCK: a (job, business date, shift).
//
// Deliberately shaped like the occurrence the calendar renderers were written
// for — `occurrenceDate` is the business date, `startsAt`/`endsAt` are INSTANTS
// the server built from the wall-clock shift boundaries in the plan's zone — so
// TimeGrid, DateGrid and AgendaList needed a new label, not a new geometry.
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

// `truncated` is NEVER silently dropped by a caller — the cap exists so one wide
// window cannot exhaust memory, and a calendar that quietly omits a shift is
// worse than one that says it did.
type ShiftBlockList = {
  blocks: ShiftBlock[];
  truncated: boolean;
};

type PlanItemList = {
  items: PlanItem[];
  truncated: boolean;
};

type JobPage = {
  rows: JobSummary[];
  meta: PageMeta | undefined;
};

// ---------------------------------------------------------------------------
// The CSV, as it crosses the wire
// ---------------------------------------------------------------------------

// ONE CSV DATA ROW, AS TEXT-SHAPED CELLS. The browser checks SYNTAX only
// (lib/job-plan-csv.ts) and sends these; RESOLVING them — which line, machine,
// product and unit — is the server's, because it needs master data and a browser
// is not a source of truth about master data.
//
// `row` is the 1-based DATA row number (header excluded).
type RawPlanRow = {
  row: number;
  // YYYY-MM-DD, converted from the CSV's DD/MM/YYYY.
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
  // 0 when the issue is about the job as a whole rather than one row.
  row: number;
  field: string;
  message: string;
};

// What preview answers, AND what a failed save answers — so the dialog has ONE
// shape to render whether the problem was found before Save or at it.
type PlanPreview = {
  rows: PlanRow[];
  issues: PlanIssue[];
  // Rows with no shift ticked. Skipped, not errors: that is how a planner says
  // "not this SKU on this machine today" in a template that lists every pair.
  ignoredRows: number;
};

// The body POST /jobs/preview, POST /jobs and PUT /jobs/:id all take.
type JobBody = JobHeader & {
  managerIds: string[];
  foremanIds: string[];
  afaIds: string[];
  plan: RawPlanRow[];
};

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

type ActivityAction = "CREATED" | "UPDATED" | "DELETED";

// One field that changed, ALREADY WORDED by the server. Not raw column values:
// a log that needs today's rendering code to be legible is not an audit trail.
type ActivityChange = {
  field: string;
  from: string;
  to: string;
};

type ActivityEntry = {
  id: number;
  // NULL once the job has been deleted. The row outlives it on purpose — see
  // the ON DELETE SET NULL note in the api's migrations — so the drawer must
  // handle a null here rather than assuming it can link to the job.
  jobId: number | null;
  // "Job #12 · 01 Oct – 10 Oct 2026", denormalised for the same reason.
  jobLabel: string;
  action: ActivityAction;
  actorId: string;
  actorName: string | null;
  at: string;
  // NULL for CREATED and DELETED, where there is no before-and-after.
  changes: ActivityChange[] | null;
};

export type {
  ActivityAction,
  ActivityChange,
  ActivityEntry,
  AreaSummary,
  CalendarViewMode,
  Job,
  JobBody,
  JobHeader,
  JobPage,
  JobPerson,
  JobRole,
  JobSummary,
  Me,
  OvertimeUnit,
  PageMeta,
  PlanIssue,
  PlanItem,
  PlanItemList,
  PlanPreview,
  PlanRow,
  ProductSummary,
  RawPlanRow,
  RoleUser,
  ScheduleTab,
  ShiftBlock,
  ShiftBlockList,
  ShiftNumber,
  WebResponse,
  WorkCenterSummary,
  WorkUnitSummary,
};
export { CALENDAR_VIEW_MODES, SCHEDULE_TABS };
