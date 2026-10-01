import { chunk } from "@molca/helper";

import { traced } from "../../shared/database/postgres.js";

import type { PostgresDB, TransactionDB } from "../../shared/database/postgres.js";
import type {
  ActivityChange,
  ActivityEntry,
  ActivityWrite,
  Job,
  JobListQuery,
  JobPerson,
  JobSummary,
  JobWrite,
  PlanItem,
  PlanRow,
  PlanWindowQuery,
  ShiftNumber,
} from "./job.js";

// SQL for the `job_schedule` schema.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY bigint IS CAST TO int, EVERY numeric TO float8, EVERY date TO text
// ─────────────────────────────────────────────────────────────────────────────
//
// postgres.js returns `bigint` and `numeric` as STRINGS (neither fits a JS
// number losslessly) and `date` as a JS Date at LOCAL midnight. The domain types
// say `number` and `string`, TypeScript cannot see the difference at the driver
// boundary, and every one of the three fails far from here:
//
//   · "100" !== 100, so a Map keyed by machine id misses and a React Query key
//     of ["job", "5"] is a different entry from ["job", 5]
//   · "200.000" + "100.000" is "200.000100.000" on the Gantt's line total
//   · a date read at local midnight in America/New_York serialises as the
//     PREVIOUS day in UTC — which the suite's TZ exists to catch
//
// None of it throws. The integration suite is what surfaced the first one; the
// casts below are why the other two never shipped.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PLAN LOCK
// ─────────────────────────────────────────────────────────────────────────────
//
// "A machine, date and shift belong to at most one job" is not expressible as a
// constraint over three boolean columns, so it is a CHECK-THEN-WRITE — and a
// check-then-write is a race:
//
//     planner A                         planner B
//     ─────────                         ─────────
//     conflicts? none                   conflicts? none
//     INSERT machine 7, Fri, S2         INSERT machine 7, Fri, S2   ← both commit
//
// Every plan write therefore takes ONE transaction-scoped advisory lock before
// its conflict check, so the second writer's check runs after the first commits
// and sees its rows. One lock for the whole schema rather than one per machine:
// writes here are a person pressing Save, a few a day, and a per-machine lock
// set taken in arbitrary order is a deadlock waiting for two plans that share
// machines. The integration suite fires two overlapping saves at once to prove
// exactly one wins.

type JobReader = {
  listJobs: (query: JobListQuery) => Promise<{ items: JobSummary[]; totalElements: number }>;
  listShiftBlocks: (query: PlanWindowQuery, cap: number) => Promise<ShiftBlockRow[]>;
  listPlanItems: (query: PlanWindowQuery, cap: number) => Promise<PlanItem[]>;
  findById: (id: number) => Promise<Job | undefined>;
  findConflicts: (plan: PlanRow[], excludeJobId: number | null) => Promise<PlanConflict[]>;
};

type JobWriter = {
  // Each takes the audit row it should record, so the DIFF — which needs the
  // previous state and knows how to word it — stays in the service while the
  // atomicity stays here.
  create: (write: JobWrite, activity: ActivityDraft) => Promise<CreateOutcome>;
  // `activity` is NULL when the update changed nothing worth recording.
  update: (id: number, write: JobWrite, activity: ActivityDraft | null) => Promise<UpdateOutcome>;
};

type ActivityReader = {
  listActivity: (limit: number, before?: number) => Promise<ActivityEntry[]>;
};

// An audit row before the job id exists. The label is a function of the id —
// "Job #12 · …" — and on a create the id is only known inside the transaction.
type ActivityDraft = Omit<ActivityWrite, "jobId" | "jobLabel"> & {
  label: (jobId: number) => string;
};

// One machine-date-shift another job already holds.
type PlanConflict = {
  jobId: number;
  workUnitId: number;
  planDate: string;
  shift: ShiftNumber;
};

// A write that lost the race, or found an overlap the preview did not (the
// other job was saved in between). The service turns it into a 409.
type CreateOutcome = { ok: true; id: number } | { ok: false; conflicts: PlanConflict[] };
type UpdateOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "conflict"; conflicts: PlanConflict[] };

// What the Calendar read aggregates to; the service adds the instants.
type ShiftBlockRow = {
  jobId: number;
  planDate: string;
  shift: ShiftNumber;
  timeZone: string;
  lineNames: string[];
  lineCount: number;
  machineCount: number;
  skuCount: number;
};

// postgres.js's parameter ceiling is 65,534 per statement. A plan row is 16
// parameters, so the 5,000-row plan the dto allows is 80,000 in one INSERT and
// is refused. 1,000 rows is 16,000 — a quarter of the ceiling, five statements
// for the largest plan, all inside the one transaction.
const PLAN_INSERT_CHUNK = 1_000;

const PLAN_LOCK_KEY = "job_schedule.plan";

class JobRepository implements JobReader, JobWriter, ActivityReader {
  private db: PostgresDB;

  constructor({ jobDb }: { jobDb: PostgresDB }) {
    this.db = jobDb;
  }

  // The scope filters shared by every window read. A plan row matches when its
  // line is one of the selected lines AND its machine is one of the selected
  // machines; an empty selection is "no filter", which is what a cleared
  // multi-select sends.
  //
  // Hoisted rather than inlined: ANY backtick inside the SQL — even in a comment
  // — closes the literal, and naming the fragments keeps each query readable.
  private scope(alias: "i", query: Pick<PlanWindowQuery, "workCenterIds" | "workUnitIds">) {
    const db = this.db;
    const EMPTY = db``;
    const lines =
      query.workCenterIds.length === 0
        ? EMPTY
        : db`AND ${db(alias)}.work_center_id IN ${db(query.workCenterIds)}`;
    const machines =
      query.workUnitIds.length === 0
        ? EMPTY
        : db`AND ${db(alias)}.work_unit_id IN ${db(query.workUnitIds)}`;
    return db`${lines} ${machines}`;
  }

  // THE TABLE VIEW.
  //
  // THE RANGE IS INCLUSIVE, THE WINDOW HALF-OPEN, and this predicate is where the
  // two conventions meet:
  //
  //     job   [start_date ......... end_date]         inclusive, as planners say it
  //     view          [from ................ to)      half-open, as windows are
  //
  //     overlap  ⇔  start_date < to  AND  end_date >= from
  //
  // Rows and total are TWO queries run in parallel over the same WHERE, the
  // pattern mes-oee-monitor's paged reports use: COUNT(*) OVER () would make
  // every row carry the total and still has to count the whole match.
  async listJobs(query: JobListQuery): Promise<{ items: JobSummary[]; totalElements: number }> {
    const db = this.db;
    const { from, to, page, size } = query;

    const range =
      from === undefined || to === undefined
        ? db``
        : db`AND j.start_date < ${to}::date AND j.end_date >= ${from}::date`;
    const scoped = query.workCenterIds.length > 0 || query.workUnitIds.length > 0;
    // EXISTS rather than a join: a job with 560 matching rows is still ONE row
    // of the table.
    const scopeFilter = scoped
      ? db`AND EXISTS (SELECT 1 FROM job_schedule.job_plan_items i
                       WHERE i.job_id = j.id ${this.scope("i", query)})`
      : db``;

    const [rows, totals] = await traced("select", "job_schedule.jobs", async () => {
      return await Promise.all([
        db`
          SELECT j.id::int,
                 to_char(j.start_date, 'YYYY-MM-DD') AS start_date,
                 to_char(j.end_date, 'YYYY-MM-DD')   AS end_date,
                 j.roll_yield::float8, j.bag_yield::float8, j.wd_today::float8,
                 j.rw_personnel, j.tw_personnel, j.overtime::float8, j.overtime_unit, j.notes,
                 j.created_by_id, j.created_by_name, j.created_at,
                 COALESCE(p.line_names, '{}') AS line_names,
                 COALESCE(p.plan_row_count, 0)::int AS plan_row_count
          FROM job_schedule.jobs j
          LEFT JOIN LATERAL (
            SELECT array_agg(DISTINCT i.work_center_name ORDER BY i.work_center_name) AS line_names,
                   count(*) AS plan_row_count
            FROM job_schedule.job_plan_items i
            WHERE i.job_id = j.id
          ) p ON TRUE
          WHERE TRUE ${range} ${scopeFilter}
          ORDER BY j.start_date DESC, j.id DESC
          LIMIT ${size} OFFSET ${(page - 1) * size}
        ` as unknown as Promise<JobSummary[]>,
        db<{ value: number }[]>`
          SELECT count(*)::int AS value
          FROM job_schedule.jobs j
          WHERE TRUE ${range} ${scopeFilter}
        `,
      ]);
    });

    return { items: [...rows], totalElements: totals[0]?.value ?? 0 };
  }

  // THE CALENDAR READ: one row per (job, business date, shift).
  //
  // The three shift flags are unpivoted with a LATERAL VALUES rather than stored
  // as three rows, because the table stores what the planner wrote — one CSV row,
  // one target — and a shift is a way of LOOKING at it (see 0003's header).
  //
  // THE DAY BEFORE THE WINDOW IS READ TOO, FOR SHIFT 3 ONLY. Shift 3 of the last
  // day before `from` runs until 07:00 ON `from`, so it is on screen in the
  // window's first morning even though its business date is outside it:
  //
  //     from - 1                    from
  //     ──────────────────┬─────────┬────────────────
  //                    23:00      00:00      07:00
  //                       │◀─── S3 of (from-1) ──▶│   ← drawn in the window
  //
  // Without it, Monday's calendar starts every week with an empty 00:00–07:00.
  //
  // `cap + 1` rows are asked for so the service can tell "exactly the cap" from
  // "more than the cap" without a second COUNT.
  async listShiftBlocks(query: PlanWindowQuery, cap: number): Promise<ShiftBlockRow[]> {
    const db = this.db;
    const { from, to } = query;

    return await traced("select", "job_schedule.job_plan_items", async () => {
      return (await db`
        SELECT i.job_id::int,
               to_char(i.plan_date, 'YYYY-MM-DD') AS plan_date,
               s.shift,
               j.time_zone,
               array_agg(DISTINCT i.work_center_name ORDER BY i.work_center_name) AS line_names,
               count(DISTINCT i.work_center_id)::int AS line_count,
               count(DISTINCT i.work_unit_id)::int   AS machine_count,
               count(DISTINCT i.product_id)::int     AS sku_count
        FROM job_schedule.job_plan_items i
        JOIN job_schedule.jobs j ON j.id = i.job_id
        CROSS JOIN LATERAL (VALUES (1, i.shift1), (2, i.shift2), (3, i.shift3)) AS s(shift, ticked)
        WHERE s.ticked
          AND (
            (i.plan_date >= ${from}::date AND i.plan_date < ${to}::date)
            OR (i.plan_date = ${from}::date - 1 AND s.shift = 3)
          )
          ${this.scope("i", query)}
        GROUP BY i.job_id, i.plan_date, s.shift, j.time_zone
        ORDER BY i.plan_date, s.shift, i.job_id
        LIMIT ${cap + 1}
      `) as unknown as ShiftBlockRow[];
    });
  }

  // THE GANTT READ: plan rows whose business date is in the window, whole.
  // Merging them into bars is the browser's (web lib/gantt-bars.ts) — it is pure
  // layout, and doing it here would make the response shape a rendering choice.
  async listPlanItems(query: PlanWindowQuery, cap: number): Promise<PlanItem[]> {
    const db = this.db;
    const { from, to } = query;

    return await traced("select", "job_schedule.job_plan_items", async () => {
      return (await db`
        SELECT i.job_id::int, ${planColumns(db, "i")}
        FROM job_schedule.job_plan_items i
        WHERE i.plan_date >= ${from}::date AND i.plan_date < ${to}::date
          ${this.scope("i", query)}
        ORDER BY i.work_center_name, i.work_unit_name, i.plan_date, i.job_id, i.product_code
        LIMIT ${cap + 1}
      `) as unknown as PlanItem[];
    });
  }

  async findById(id: number): Promise<Job | undefined> {
    const db = this.db;
    return await traced("select", "job_schedule.jobs", async () => {
      const [header] = (await db`
        SELECT j.id::int,
               to_char(j.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(j.end_date, 'YYYY-MM-DD')   AS end_date,
               j.time_zone,
               j.roll_yield::float8, j.bag_yield::float8, j.wd_today::float8,
               j.rw_personnel, j.tw_personnel, j.overtime::float8, j.overtime_unit, j.notes,
               j.created_by_id, j.created_by_name, j.created_at,
               j.updated_by_id, j.updated_by_name, j.updated_at
        FROM job_schedule.jobs j
        WHERE j.id = ${id}
      `) as unknown as Omit<Job, "people" | "plan">[];
      if (header === undefined) return undefined;

      // Two more queries rather than a join: a join would multiply the header by
      // people x plan rows — 3 x 560 copies of one job — for a dedupe in Node.
      const [people, plan] = await Promise.all([
        db`
          SELECT role, user_id, user_name
          FROM job_schedule.job_people
          WHERE job_id = ${id}
          ORDER BY role, user_name
        ` as unknown as Promise<JobPerson[]>,
        db`
          SELECT ${planColumns(db, "i")}
          FROM job_schedule.job_plan_items i
          WHERE i.job_id = ${id}
          ORDER BY i.plan_date, i.work_center_name, i.work_unit_name, i.product_code
        ` as unknown as Promise<PlanRow[]>,
      ]);
      return { ...header, people: [...people], plan: [...plan] };
    });
  }

  // Which of `plan`'s machine-date-shifts another job already holds.
  //
  // Unlocked when the preview calls it — a preview is advice. The write path
  // calls conflictsIn() instead, under the plan lock, and that one is the rule.
  async findConflicts(plan: PlanRow[], excludeJobId: number | null): Promise<PlanConflict[]> {
    return await conflictsIn(this.db, plan, excludeJobId);
  }

  async create(write: JobWrite, activity: ActivityDraft): Promise<CreateOutcome> {
    return await traced("insert", "job_schedule.jobs", async () => {
      return await this.db.begin(async (tx) => {
        await lockPlans(tx);
        const conflicts = await conflictsIn(tx, write.plan, null);
        // Returning rather than throwing: postgres.js rolls back on a throw, but
        // a returned value is the only way the conflicts leave the transaction
        // without being wrapped in a driver error.
        if (conflicts.length > 0) return { ok: false as const, conflicts };

        const [row] = await tx`
          INSERT INTO job_schedule.jobs ${tx({
            ...headerColumns(write),
            // Set on INSERT ONLY — see headerColumns for why they are not in it.
            createdById: write.actorId,
            createdByName: write.actorName,
          })}
          RETURNING id::int
        `;
        const id = (row as { id: number }).id;
        await insertChildren(tx, id, write);
        // INSIDE THE SAME TRANSACTION as the rows it describes. An audit trail
        // written afterwards silently loses entries whenever the process dies
        // between the two statements.
        await insertActivity(tx, id, activity);
        return { ok: true as const, id };
      });
    });
  }

  // WHOLE-JOB UPDATE. People and plan are REPLACED, not diffed: re-uploading the
  // CSV is how a plan is edited (the dialog says so), and "replace" is the same
  // shape as create — one fewer way for the two paths to disagree.
  async update(
    id: number,
    write: JobWrite,
    activity: ActivityDraft | null,
  ): Promise<UpdateOutcome> {
    return await traced("update", "job_schedule.jobs", async () => {
      return await this.db.begin(async (tx) => {
        await lockPlans(tx);
        // The job's OWN rows are excluded: re-saving a plan unchanged must not
        // conflict with itself.
        const conflicts = await conflictsIn(tx, write.plan, id);
        if (conflicts.length > 0)
          return { ok: false as const, reason: "conflict" as const, conflicts };

        const updated = await tx`
          UPDATE job_schedule.jobs
          SET ${tx({
            ...headerColumns(write),
            updatedById: write.actorId,
            updatedByName: write.actorName,
            updatedAt: new Date(),
          })}
          WHERE id = ${id}
          RETURNING id
        `;
        if (updated.length === 0) return { ok: false as const, reason: "not_found" as const };

        await tx`DELETE FROM job_schedule.job_people WHERE job_id = ${id}`;
        await tx`DELETE FROM job_schedule.job_plan_items WHERE job_id = ${id}`;
        await insertChildren(tx, id, write);
        if (activity !== null) await insertActivity(tx, id, activity);
        return { ok: true as const };
      });
    });
  }

  // THE FEED. Newest first, keyset-paginated on `id` — see the dto for why not
  // OFFSET. It never joins back to `jobs`: rows whose job is gone have a NULL
  // `job_id` by design, and a join invites reading the live label and silently
  // rewriting history.
  async listActivity(limit: number, before?: number): Promise<ActivityEntry[]> {
    const db = this.db;
    const cursor = before === undefined ? db`` : db`WHERE id < ${before}`;

    const rows = await traced("select", "job_schedule.activity_log", async () => {
      return (await db`
        SELECT id::int, job_id::int, job_label, action, actor_id, actor_name, at,
               changes::text
        FROM job_schedule.activity_log
        ${cursor}
        ORDER BY at DESC, id DESC
        LIMIT ${limit}
      `) as unknown as (Omit<ActivityEntry, "changes"> & { changes: string | null })[];
    });

    return rows.map((row) => ({ ...row, changes: parseChanges(row.changes) }));
  }
}

// The plan columns every read selects, with the casts the header explains.
function planColumns(db: PostgresDB | TransactionDB, alias: "i") {
  const a = db(alias);
  return db`
    to_char(${a}.plan_date, 'YYYY-MM-DD') AS plan_date,
    ${a}.work_center_id::int, ${a}.work_center_name,
    ${a}.work_unit_id::int, ${a}.work_unit_name,
    ${a}.product_id::int, ${a}.product_code, ${a}.product_name,
    ${a}.target::float8, ${a}.uom_code, ${a}.uom_name,
    ${a}.shift1, ${a}.shift2, ${a}.shift3
  `;
}

async function lockPlans(tx: TransactionDB): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${PLAN_LOCK_KEY}))`;
}

// The overlap query. The candidate cells cross as ONE jsonb parameter,
// unpacked by jsonb_to_recordset, rather than as five parallel arrays: five
// arrays that must stay index-aligned are a bug waiting for one of them to be
// sorted. `sql.json` for the reason 0002's `changes` column documents — it
// encodes once, where JSON.stringify + a cast would encode twice.
//
// Candidates are merged per (machine, date) first: a plan listing four SKUs on
// one machine on one day is one question to ask, not four.
async function conflictsIn(
  db: PostgresDB | TransactionDB,
  plan: PlanRow[],
  excludeJobId: number | null,
): Promise<PlanConflict[]> {
  if (plan.length === 0) return [];

  const cells = new Map<
    string,
    { work_unit_id: number; plan_date: string; s1: boolean; s2: boolean; s3: boolean }
  >();
  for (const row of plan) {
    const key = `${row.workUnitId}|${row.planDate}`;
    const cell = cells.get(key);
    if (cell === undefined) {
      cells.set(key, {
        work_unit_id: row.workUnitId,
        plan_date: row.planDate,
        s1: row.shift1,
        s2: row.shift2,
        s3: row.shift3,
      });
    } else {
      cell.s1 ||= row.shift1;
      cell.s2 ||= row.shift2;
      cell.s3 ||= row.shift3;
    }
  }

  const exclude = excludeJobId === null ? db`` : db`AND i.job_id <> ${excludeJobId}`;

  const rows = (await db`
    SELECT DISTINCT i.job_id::int, c.work_unit_id, to_char(c.plan_date, 'YYYY-MM-DD') AS plan_date,
           s.shift
    FROM jsonb_to_recordset(${db.json([...cells.values()])}::jsonb)
         AS c(work_unit_id int, plan_date date, s1 boolean, s2 boolean, s3 boolean)
    JOIN job_schedule.job_plan_items i
      ON i.work_unit_id = c.work_unit_id AND i.plan_date = c.plan_date
    CROSS JOIN LATERAL (VALUES (1, c.s1 AND i.shift1),
                               (2, c.s2 AND i.shift2),
                               (3, c.s3 AND i.shift3)) AS s(shift, clash)
    WHERE s.clash ${exclude}
    ORDER BY plan_date, c.work_unit_id, s.shift
  `) as unknown as PlanConflict[];
  return [...rows];
}

// The columns common to insert and update.
//
// THE AUTHOR COLUMNS ARE DELIBERATELY ABSENT, and each caller adds its own half:
// `create` sets created_by_*, `update` sets updated_by_*. Putting created_by_*
// here would rewrite the author of a job every time somebody else edited it.
// (The inherited version of this helper once made `create` forget its half, and
// only the integration suite noticed — the NOT NULL refused the first save.)
function headerColumns(write: JobWrite) {
  return {
    startDate: write.startDate,
    endDate: write.endDate,
    timeZone: write.timeZone,
    rollYield: write.rollYield,
    bagYield: write.bagYield,
    wdToday: write.wdToday,
    rwPersonnel: write.rwPersonnel,
    twPersonnel: write.twPersonnel,
    overtime: write.overtime,
    overtimeUnit: write.overtimeUnit,
    notes: write.notes,
  };
}

async function insertChildren(tx: TransactionDB, jobId: number, write: JobWrite) {
  if (write.people.length > 0) {
    await tx`INSERT INTO job_schedule.job_people ${tx(
      write.people.map((person) => ({ jobId, ...person })),
    )}`;
  }
  for (const rows of chunk(write.plan, PLAN_INSERT_CHUNK)) {
    await tx`INSERT INTO job_schedule.job_plan_items ${tx(rows.map((row) => ({ jobId, ...row })))}`;
  }
}

// `changes` crosses the driver as TEXT in both directions — see 0002 and the
// AGENTS.md note. Writing uses `tx.json()`, never JSON.stringify + ::jsonb (which
// encodes twice and stores a jsonb STRING); reading selects `changes::text` and
// parses here, in the one place, because the driver hands this column back as a
// raw string.
async function insertActivity(tx: TransactionDB, jobId: number, activity: ActivityDraft) {
  await tx`
    INSERT INTO job_schedule.activity_log
      (job_id, job_label, action, actor_id, actor_name, changes)
    VALUES (
      ${jobId},
      ${activity.label(jobId)},
      ${activity.action},
      ${activity.actorId},
      ${activity.actorName},
      ${activity.changes === null ? null : tx.json(activity.changes)}
    )
  `;
}

function parseChanges(raw: string | null): ActivityChange[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // A row written by hand, or by a future shape, must not take the feed down.
    return Array.isArray(parsed) ? (parsed as ActivityChange[]) : null;
  } catch {
    return null;
  }
}

export { JobRepository, PLAN_INSERT_CHUNK, parseChanges };
export type {
  ActivityDraft,
  ActivityReader,
  CreateOutcome,
  JobReader,
  JobWriter,
  PlanConflict,
  ShiftBlockRow,
  UpdateOutcome,
};
