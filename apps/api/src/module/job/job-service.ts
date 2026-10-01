import { HTTPException } from "hono/http-exception";

import { diffJob, jobLabel } from "./activity-diff.js";
import { shiftInstants } from "../../shared/shift.js";
import {
  getJobResolveDurationHistogram,
  getJobWindowRowsHistogram,
  getJobWindowTruncationsCounter,
  getJobWritesCounter,
} from "../../shared/observability/metrics.js";

import type { MasterDataServiceContract } from "../master-data/master-data-service.js";
import type { TimeZoneResolverContract } from "../master-data/time-zone-resolver.js";
import type { UserServiceContract } from "../user/user-service.js";
import type { Actor } from "../../shared/actor.js";
import type { JobBody } from "./job-dto.js";
import type {
  ActivityEntry,
  Job,
  JobListQuery,
  JobPerson,
  JobRole,
  JobSummary,
  JobWrite,
  PlanIssue,
  PlanItem,
  PlanPreview,
  PlanRow,
  PlanWindowQuery,
  ShiftBlock,
} from "./job.js";
import type { ActivityReader, JobReader, JobWriter, PlanConflict } from "./job-repository.js";

// Orchestration for jobs: resolving an uploaded plan against master data, the
// checks a browser cannot be trusted to have made, and the window reads.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE RESOLUTION, THREE CALLERS
// ─────────────────────────────────────────────────────────────────────────────
//
//   POST /jobs/preview ─┐
//   POST /jobs ─────────┼─▶ resolve(body) ─▶ { rows, issues, ignoredRows }
//   PUT  /jobs/:id ─────┘      │
//                              ├─ 1. people: every id holds its realm role
//                              ├─ 2. each row with a shift ticked:
//                              │      date ∈ job range
//                              │      line by NAME (unique across areas)
//                              │      machine by NAME, ON that line
//                              │      SKU by CODE, assigned to that line
//                              │      no duplicate (date, machine, SKU)
//                              ├─ 3. finish-good unit per machine (count points)
//                              └─ 4. no machine-date-shift another job holds
//
// Preview and save run THE SAME FUNCTION, so the confirmation table shows exactly
// what Save would write — and Save re-runs it rather than trusting the preview,
// because master data can move between the two (a machine re-parented to another
// line while the planner was reading the table). Save answers a failure with the
// preview's own shape, so the dialog renders one thing either way.
//
// Step 4 runs again INSIDE the write transaction, under the plan lock (see
// job-repository.ts). The unlocked run here exists so preview can show conflicts;
// the locked run is the rule.
//
// NAMES FOR LINES AND MACHINES, A CODE FOR THE SKU. The template lists what a
// planner can read, and lines and machines are unique by name within their
// parents. SKU names are not — the sample plant has two products both called
// "SKU Line 9F" — so the product is matched on its code, the one key master data
// guarantees unique. An ambiguous name is an issue, never a guess: a wrong guess
// plans the wrong product and renders exactly like the right one.

// The window-read caps. The request is already bounded by the dto (400 days for
// the Calendar, 31 for the Gantt); these bound the ANSWER, and truncation travels
// in the payload so no caller can read the rows without being told there were
// more. 5,000 Calendar blocks is ~50 jobs x 3 shifts x a month; 20,000 plan rows
// is a month of the largest sample plant three times over.
const MAX_SHIFT_BLOCKS = 5_000;
const MAX_PLAN_ITEMS = 20_000;

// Count-point reads in flight at once. The cache makes a warm resolve free; a cold
// one on a 60-machine plan is 60 upstream calls, and firing all of them at once
// is how a Save becomes a burst upstream rate-limits.
const COUNT_POINT_CONCURRENCY = 8;

const GOOD_OUTPUT_ROLE = "good_output";

type JobServiceContract = {
  listJobs: (query: JobListQuery) => Promise<{ items: JobSummary[]; totalElements: number }>;
  listShiftBlocks: (
    query: PlanWindowQuery,
  ) => Promise<{ blocks: ShiftBlock[]; truncated: boolean }>;
  listPlanItems: (query: PlanWindowQuery) => Promise<{ items: PlanItem[]; truncated: boolean }>;
  getById: (id: number) => Promise<Job>;
  preview: (body: JobBody, excludeJobId?: number) => Promise<PlanPreview>;
  create: (body: JobBody, actor: Actor) => Promise<Job>;
  update: (id: number, body: JobBody, actor: Actor) => Promise<Job>;
  listActivity: (limit: number, before?: number) => Promise<ActivityEntry[]>;
};

type Deps = {
  jobRepository: JobReader & JobWriter & ActivityReader;
  masterDataService: MasterDataServiceContract;
  timeZoneResolver: TimeZoneResolverContract;
  userService: UserServiceContract;
};

// A plan the service refused, carrying the preview-shaped answer. The handler
// renders it as `{ data: PlanPreview, error }` with the status on it — 409 when
// every issue is another job's claim on the same machine, 400 otherwise.
class PlanRejectedError extends Error {
  readonly status: 400 | 409;
  readonly preview: PlanPreview;

  constructor(preview: PlanPreview) {
    super("plan has issues");
    this.name = "PlanRejectedError";
    this.preview = preview;
    this.status = preview.issues.every((issue) => issue.field.startsWith("shift")) ? 409 : 400;
  }
}

// Case- and space-insensitive: "Molca Line 1" and "molca  line 1 " are the same
// line to a planner typing into a spreadsheet, and a trailing space Excel added
// must not become "unknown line".
function nameKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function indexByName<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const key = nameKey(item.name);
    const list = index.get(key);
    if (list === undefined) index.set(key, [item]);
    else list.push(item);
  }
  return index;
}

// "2026-09-25" -> "25/09/2026", the way the planner typed it in the CSV.
function csvDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

// Runs `task` over `items` with at most `limit` in flight, preserving order.
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type Resolution = {
  preview: PlanPreview;
  sourceRows: number[];
  people: JobPerson[];
  timeZone: string;
};

class JobService implements JobServiceContract {
  private repository: JobReader & JobWriter & ActivityReader;
  private masterData: MasterDataServiceContract;
  private timeZones: TimeZoneResolverContract;
  private users: UserServiceContract;

  constructor({ jobRepository, masterDataService, timeZoneResolver, userService }: Deps) {
    this.repository = jobRepository;
    this.masterData = masterDataService;
    this.timeZones = timeZoneResolver;
    this.users = userService;
  }

  async listJobs(query: JobListQuery) {
    return await this.repository.listJobs(query);
  }

  async listShiftBlocks(query: PlanWindowQuery) {
    const rows = await this.repository.listShiftBlocks(query, MAX_SHIFT_BLOCKS);
    const truncated = rows.length > MAX_SHIFT_BLOCKS;
    const kept = truncated ? rows.slice(0, MAX_SHIFT_BLOCKS) : rows;

    // Both instruments exist because the failure they describe is INVISIBLE over
    // HTTP: the request answers 200 either way.
    getJobWindowRowsHistogram().record(kept.length, { read: "shifts" });
    if (truncated) getJobWindowTruncationsCounter().add(1, { read: "shifts" });

    const blocks = kept.map((row): ShiftBlock => {
      const { startsAt, endsAt } = shiftInstants(row.planDate, row.shift, row.timeZone);
      return {
        jobId: row.jobId,
        occurrenceDate: row.planDate,
        shift: row.shift,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        timeZone: row.timeZone,
        lineNames: row.lineNames,
        lineCount: row.lineCount,
        machineCount: row.machineCount,
        skuCount: row.skuCount,
      };
    });
    return { blocks, truncated };
  }

  async listPlanItems(query: PlanWindowQuery) {
    const rows = await this.repository.listPlanItems(query, MAX_PLAN_ITEMS);
    const truncated = rows.length > MAX_PLAN_ITEMS;
    const items = truncated ? rows.slice(0, MAX_PLAN_ITEMS) : rows;

    getJobWindowRowsHistogram().record(items.length, { read: "plan" });
    if (truncated) getJobWindowTruncationsCounter().add(1, { read: "plan" });

    return { items, truncated };
  }

  async getById(id: number): Promise<Job> {
    const job = await this.repository.findById(id);
    if (job === undefined) throw new HTTPException(404, { message: "job not found" });
    return job;
  }

  async preview(body: JobBody, excludeJobId?: number): Promise<PlanPreview> {
    return (await this.resolve(body, excludeJobId ?? null, "preview")).preview;
  }

  async create(body: JobBody, actor: Actor): Promise<Job> {
    const resolution = await this.resolve(body, null, "create");
    const { preview, people, timeZone } = resolution;
    this.rejectIfIssues(preview, "create");

    const write = this.toWrite(body, preview.rows, people, timeZone, actor);
    const outcome = await this.repository.create(write, {
      action: "CREATED",
      actorId: actor.subject,
      actorName: actor.name,
      // No diff: there is no "before". NULL rather than [] says that.
      changes: null,
      label: (id) => jobLabel(id, write.startDate, write.endDate),
    });
    if (!outcome.ok) this.rejectConflicts(resolution, outcome.conflicts, "create");

    getJobWritesCounter().add(1, { operation: "create", outcome: "ok" });
    return await this.getById(outcome.id);
  }

  async update(id: number, body: JobBody, actor: Actor): Promise<Job> {
    // Read BEFORE the upstream work: a 404 costs no master-data calls, and this
    // is the "before" the diff is computed against.
    const previous = await this.getById(id);
    const resolution = await this.resolve(body, id, "update");
    const { preview, people, timeZone } = resolution;
    this.rejectIfIssues(preview, "update");

    const write = this.toWrite(body, preview.rows, people, timeZone, actor);
    const changes = diffJob(previous, write);

    // NOTHING MOVED, SO NOTHING IS LOGGED — but the write still happens, so the
    // caller gets the same answer either way. A log full of empty saves is a log
    // nobody scrolls.
    const outcome = await this.repository.update(
      id,
      write,
      changes.length === 0
        ? null
        : {
            action: "UPDATED",
            actorId: actor.subject,
            actorName: actor.name,
            changes,
            label: (jobId) => jobLabel(jobId, write.startDate, write.endDate),
          },
    );
    if (!outcome.ok && outcome.reason === "not_found") {
      throw new HTTPException(404, { message: "job not found" });
    }
    if (!outcome.ok && outcome.reason === "conflict") {
      this.rejectConflicts(resolution, outcome.conflicts, "update");
    }

    getJobWritesCounter().add(1, { operation: "update", outcome: "ok" });
    return await this.getById(id);
  }

  async listActivity(limit: number, before?: number): Promise<ActivityEntry[]> {
    return await this.repository.listActivity(limit, before);
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  private async resolve(
    body: JobBody,
    excludeJobId: number | null,
    operation: "preview" | "create" | "update",
  ): Promise<Resolution> {
    const startedAt = Date.now();
    try {
      const issues: PlanIssue[] = [];
      const people = await this.resolvePeople(body, issues);
      const { rows, sourceRows, ignoredRows } = await this.resolveRows(body, issues);

      if (rows.length === 0 && issues.length === 0) {
        // Every row unticked. Not a malformed file — a plan that plans nothing,
        // which would save a job with no block and no bar anywhere.
        issues.push({ row: 0, field: "plan", message: "no row has a shift ticked" });
      }

      // Only once the rows themselves are clean: a conflict against a row that
      // names the wrong machine is noise about a row that is already wrong.
      if (issues.length === 0 && rows.length > 0) {
        const conflicts = await this.repository.findConflicts(rows, excludeJobId);
        issues.push(...conflictIssues(conflicts, rows, sourceRows));
      }

      // The plant's zone, from the plan's first machine. Resolved even for a
      // preview so an unresolvable zone fails the PREVIEW, not the Save after it.
      const timeZone =
        rows.length === 0 ? "UTC" : await this.timeZones.resolve("work-unit", rows[0]!.workUnitId);

      return { preview: { rows, issues, ignoredRows }, sourceRows, people, timeZone };
    } finally {
      getJobResolveDurationHistogram().record(Date.now() - startedAt, { operation });
    }
  }

  // Every chosen person must hold the realm role configured for their slot.
  //
  // This is the check a picker cannot replace: without it a hand-written body can
  // name anybody in the realm — or an id that names nobody — as the manager of a
  // job. The role list is only fetched when someone was chosen for that slot, so
  // a job naming nobody never depends on Keycloak being reachable.
  private async resolvePeople(body: JobBody, issues: PlanIssue[]): Promise<JobPerson[]> {
    const slots: [JobRole, string, string[]][] = [
      ["MANAGER", "managerIds", body.managerIds],
      ["FOREMAN", "foremanIds", body.foremanIds],
      ["AFA", "afaIds", body.afaIds],
    ];
    const people: JobPerson[] = [];
    for (const [role, field, ids] of slots) {
      if (ids.length === 0) continue;
      const holders = new Map((await this.users.listRoleUsers(role)).map((u) => [u.id, u.name]));
      for (const userId of ids) {
        const userName = holders.get(userId);
        if (userName === undefined) {
          issues.push({ row: 0, field, message: `user ${userId} does not hold the ${role} role` });
        } else {
          people.push({ role, userId, userName });
        }
      }
    }
    return people;
  }

  private async resolveRows(
    body: JobBody,
    issues: PlanIssue[],
  ): Promise<{ rows: PlanRow[]; sourceRows: number[]; ignoredRows: number }> {
    const ticked = body.plan.filter((raw) => raw.shift1 || raw.shift2 || raw.shift3);
    const ignoredRows = body.plan.length - ticked.length;

    const lines = await this.lineIndex();
    const resolved: PlanRow[] = [];
    // The CSV row number of each resolved row, index-aligned with `resolved`.
    // Kept beside the rows rather than on them: PlanRow is what gets stored, and
    // a row number is a fact about one upload, not about the plan.
    const sourceRows: number[] = [];
    // (date, machine, product) -> the first row that named it.
    const seen = new Map<string, number>();

    for (const raw of ticked) {
      if (raw.date < body.startDate || raw.date > body.endDate) {
        issues.push({
          row: raw.row,
          field: "date",
          message: `${csvDate(raw.date)} is outside the job's date range`,
        });
        continue;
      }

      const lineMatches = lines.get(nameKey(raw.line)) ?? [];
      if (lineMatches.length !== 1) {
        issues.push({
          row: raw.row,
          field: "line",
          message:
            lineMatches.length === 0
              ? `unknown line "${raw.line}"`
              : `line name "${raw.line}" matches ${lineMatches.length} lines`,
        });
        continue;
      }
      const line = lineMatches[0]!;

      // Both cached per line in the master-data service, so a 560-row plan over
      // ten lines is twenty cached reads, not 1,120.
      const [roster, products] = await Promise.all([
        this.masterData.listWorkUnits(line.id),
        this.masterData.listLineProducts(line.id),
      ]);

      const machineMatches = indexByName(roster).get(nameKey(raw.machine)) ?? [];
      if (machineMatches.length !== 1) {
        // Zero matches is the case a browser cannot rule out and a human easily
        // gets wrong: the machine exists, on ANOTHER line. Writing it would plan
        // production on equipment the planner did not mean.
        issues.push({
          row: raw.row,
          field: "machine",
          message:
            machineMatches.length === 0
              ? `machine "${raw.machine}" is not on line "${line.name}"`
              : `machine name "${raw.machine}" matches ${machineMatches.length} machines on "${line.name}"`,
        });
        continue;
      }
      const machine = machineMatches[0]!;

      const product = products.find((p) => p.code.trim() === raw.skuCode.trim());
      if (product === undefined) {
        issues.push({
          row: raw.row,
          field: "skuCode",
          message: `SKU code "${raw.skuCode}" is not assigned to line "${line.name}"`,
        });
        continue;
      }

      const key = `${raw.date}|${machine.id}|${product.id}`;
      const first = seen.get(key);
      if (first !== undefined) {
        // Two rows for one SKU on one machine on one day would double its target
        // on every screen that sums it. Neither is obviously the one meant.
        issues.push({
          row: raw.row,
          field: "skuCode",
          message: `duplicates row ${first} (same date, machine and SKU)`,
        });
        continue;
      }
      seen.set(key, raw.row);

      sourceRows.push(raw.row);
      resolved.push({
        planDate: raw.date,
        workCenterId: line.id,
        workCenterName: line.name,
        workUnitId: machine.id,
        workUnitName: machine.name,
        productId: product.id,
        productCode: product.code,
        productName: product.name,
        target: raw.target,
        uomCode: null,
        uomName: null,
        shift1: raw.shift1,
        shift2: raw.shift2,
        shift3: raw.shift3,
      });
    }

    await this.attachUnits(resolved);
    return { rows: resolved, sourceRows, ignoredRows };
  }

  // Every line in every area, indexed by name.
  //
  // Walks the area catalogue because mes-master-data's line list is scoped BY
  // AREA — there is no "all lines" read on this service's port. Both lists are
  // tiny and cached, so this is memory access after a process's first call.
  //
  // ACROSS ALL AREAS, not the area selected in the header: the CSV names the line,
  // and a plan for two areas is legitimate. A name that exists in two areas is
  // then ambiguous, and says so.
  private async lineIndex() {
    const areas = await this.masterData.listAreas();
    const perArea = await Promise.all(
      areas.map((area) => this.masterData.listWorkCenters(area.id)),
    );
    return indexByName(perArea.flat());
  }

  // The finish-good unit of every machine in the plan, frozen onto its rows.
  //
  // The uom of the machine's `good_output` count point. If a machine has several
  // and they DISAGREE the unit is NULL rather than the first one's: a target
  // shown under a unit the machine does not uniformly count in is a wrong number
  // that looks ordinary — the same rule mes-oee-monitor's line card follows when
  // its members disagree.
  private async attachUnits(rows: PlanRow[]): Promise<void> {
    const machineIds = [...new Set(rows.map((row) => row.workUnitId))];
    const units = await mapBounded(machineIds, COUNT_POINT_CONCURRENCY, async (id) => {
      const points = await this.masterData.listCountPoints(id);
      const uoms = points
        .filter((point) => point.role === GOOD_OUTPUT_ROLE && point.uom !== null)
        .map((point) => point.uom!);
      const codes = new Set(uoms.map((uom) => uom.code));
      return [id, codes.size === 1 ? uoms[0]! : null] as const;
    });
    const byMachine = new Map(units);
    for (const row of rows) {
      const uom = byMachine.get(row.workUnitId) ?? null;
      row.uomCode = uom?.code ?? null;
      row.uomName = uom?.name ?? null;
    }
  }

  // ---------------------------------------------------------------------------
  // Write helpers
  // ---------------------------------------------------------------------------

  private toWrite(
    body: JobBody,
    plan: PlanRow[],
    people: JobPerson[],
    timeZone: string,
    actor: Actor,
  ): JobWrite {
    return {
      startDate: body.startDate,
      endDate: body.endDate,
      rollYield: body.rollYield,
      bagYield: body.bagYield,
      wdToday: body.wdToday,
      rwPersonnel: body.rwPersonnel,
      twPersonnel: body.twPersonnel,
      overtime: body.overtime,
      overtimeUnit: body.overtimeUnit,
      notes: body.notes,
      timeZone,
      people,
      plan,
      // WHO is the verified token, never the body.
      actorId: actor.subject,
      actorName: actor.name,
    };
  }

  private rejectIfIssues(preview: PlanPreview, operation: "create" | "update"): void {
    if (preview.issues.length === 0) return;
    const error = new PlanRejectedError(preview);
    getJobWritesCounter().add(1, {
      operation,
      outcome: error.status === 409 ? "conflict" : "rejected",
    });
    throw error;
  }

  // The locked conflict check found what the unlocked one did not: another job
  // was saved in between. Same answer shape as any other rejection.
  private rejectConflicts(
    { preview, sourceRows }: Resolution,
    conflicts: PlanConflict[],
    operation: "create" | "update",
  ): never {
    const issues = conflictIssues(conflicts, preview.rows, sourceRows);
    getJobWritesCounter().add(1, { operation, outcome: "conflict" });
    throw new PlanRejectedError({ ...preview, issues });
  }
}

// One issue per plan row a conflict touches, worded with the row number the
// planner will look for in the spreadsheet.
function conflictIssues(
  conflicts: PlanConflict[],
  rows: PlanRow[],
  sourceRows: number[],
): PlanIssue[] {
  if (conflicts.length === 0) return [];

  const issues: PlanIssue[] = [];
  rows.forEach((row, index) => {
    for (const conflict of conflicts) {
      if (conflict.workUnitId !== row.workUnitId || conflict.planDate !== row.planDate) continue;
      const shiftTicked = [row.shift1, row.shift2, row.shift3][conflict.shift - 1];
      if (!shiftTicked) continue;
      issues.push({
        row: sourceRows[index] ?? 0,
        field: `shift${conflict.shift}`,
        message: `"${row.workUnitName}" on ${csvDate(row.planDate)} shift ${conflict.shift} is already planned in job #${conflict.jobId}`,
      });
    }
  });
  return issues;
}

export {
  COUNT_POINT_CONCURRENCY,
  JobService,
  MAX_PLAN_ITEMS,
  MAX_SHIFT_BLOCKS,
  PlanRejectedError,
  mapBounded,
  nameKey,
};
export type { JobServiceContract };
