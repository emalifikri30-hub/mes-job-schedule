import * as z from "zod";

import { jsonValidator, MAX_PAGE_SIZE, queryValidator } from "@molca/helper";

// VALIDATION IS THE SERVER'S JOB, AND THIS FILE IS WHERE ITS SHAPE HALF LIVES.
//
// `web` depends on no workspace package, so none of this is shared with the
// browser. The dialog checks the CSV's syntax for the sake of a fast, row-
// numbered message; the rules that hold are here and in job-service.ts, because
// a client-side rule is a suggestion.
//
// SHAPE here, MEANING in the service. This file can say "a date, a number, at
// most 5,000 rows"; only the service can say "that machine is on that line",
// because only the service can ask master data.

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A civil date, proved to be a date the calendar actually has. The regex alone
// accepts 2026-02-30, which `Date` silently turns into 2 March — a plan row for a
// day that does not exist would quietly move.
const civilDate = z
  .string()
  .check(z.regex(CIVIL_DATE))
  .check(
    z.refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }, "not a real calendar date"),
  );

const MS_PER_DAY = 86_400_000;

function spanDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;
}

// `1,2,3` -> [1, 2, 3]. Arrays cross the query string comma-separated rather
// than as repeated keys: axios and URLSearchParams disagree about how to repeat a
// key, and a comma list reads the same in a URL someone pastes into a ticket.
// Empty or absent means "no filter", which is what an unselected multi-select
// sends.
const idList = z.optional(z.string().check(z.maxLength(2000))).transform((raw, ctx) => {
  if (raw === undefined || raw.trim() === "") return [] as number[];
  const ids = raw.split(",").map((part) => Number(part.trim()));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    ctx.issues.push({ code: "custom", message: "must be a comma-separated id list", input: raw });
    return z.NEVER;
  }
  return [...new Set(ids)];
});

// ---------------------------------------------------------------------------
// The window reads
// ---------------------------------------------------------------------------

// THE CALENDAR WINDOW CAP. The Year view legitimately asks for 366 days; 400
// leaves room for a view that snaps outward and bounds what one request can ask
// this service to aggregate.
const MAX_WINDOW_DAYS = 400;

// THE GANTT WINDOW CAP, and it is much tighter on purpose. The Gantt draws one
// column per SHIFT and one row per machine, so its cost grows with days x 3 x
// machines; 31 days of a 50-machine plant is already ~4,600 slots. The browser
// clamps the sidebar's range to this and says so in a banner — this is the
// server refusing the request the browser should never have made.
const MAX_GANTT_DAYS = 31;

function windowSchema(maxDays: number) {
  return (
    z
      .object({
        from: civilDate,
        to: civilDate,
        workCenterIds: idList,
        workUnitIds: idList,
      })
      // `to` STRICTLY AFTER `from`. An empty window answers 200 with nothing,
      // which on a calendar reads as "no job planned" rather than "you asked
      // wrongly".
      .check(
        z.refine((value) => value.to > value.from, {
          error: "`to` must be after `from`",
          path: ["to"],
        }),
      )
      .check(
        z.refine((value) => spanDays(value.from, value.to) <= maxDays, {
          error: `window must not exceed ${maxDays} days`,
          path: ["to"],
        }),
      )
  );
}

const listShiftsSchema = windowSchema(MAX_WINDOW_DAYS);
const listPlanSchema = windowSchema(MAX_GANTT_DAYS);

// THE TABLE. Offset-paginated with page/size, like every table in the product —
// unlike the audit feed below, a job list is not append-only-while-you-read, so
// an offset is stable enough and gives the pager a page count.
//
// The date range is OPTIONAL here: the Table with no range is "every job,
// newest first", which is a reasonable thing to page through. Both or neither.
const listJobsSchema = z
  .object({
    page: z.optional(z.coerce.number().check(z.int(), z.gte(1))).transform((v) => v ?? 1),
    size: z
      .optional(z.coerce.number().check(z.int(), z.gte(1), z.lte(MAX_PAGE_SIZE)))
      .transform((v) => v ?? 10),
    from: z.optional(civilDate),
    to: z.optional(civilDate),
    workCenterIds: idList,
    workUnitIds: idList,
  })
  .check(
    z.refine((value) => (value.from === undefined) === (value.to === undefined), {
      error: "`from` and `to` go together",
      path: ["to"],
    }),
  )
  .check(
    z.refine((value) => value.from === undefined || value.to! > value.from, {
      error: "`to` must be after `from`",
      path: ["to"],
    }),
  );

// THE AUDIT FEED, keyset-paginated. `before` is the last id of the previous
// page, not an offset: the log is append-only and written to while somebody is
// reading it, so an OFFSET shifts under the reader and page two repeats a row.
const listActivitySchema = z.object({
  limit: z
    .optional(z.coerce.number().check(z.int(), z.gte(1), z.lte(100)))
    .transform((v) => v ?? 50),
  before: z.optional(z.coerce.number().check(z.int(), z.positive())),
});

const listUsersSchema = z.object({
  role: z.enum(["MANAGER", "FOREMAN", "AFA"]),
});

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

// THE PLAN CAPS. 62 days is two months of planning — the longest range anybody
// has described — and 5,000 rows is ~80 per day across it, above the ~56 per
// day of the largest sample plant. Both bound what one POST can make this
// service resolve against master data and hold the plan lock for.
const MAX_JOB_DAYS = 62;
const MAX_PLAN_ROWS = 5_000;

const percent = z.nullish(z.number().check(z.gte(0), z.lte(100))).transform((v) => v ?? null);
const headcount = z.nullish(z.number().check(z.int(), z.gte(0))).transform((v) => v ?? null);

// ONE CSV DATA ROW, already split into cells by the browser. Text, not ids: the
// names are resolved by the service against master data.
const rawPlanRowSchema = z.object({
  row: z.number().check(z.int(), z.positive()),
  date: civilDate,
  line: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)),
  sku: z.string().check(z.trim(), z.maxLength(200)),
  skuCode: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)),
  target: z.number().check(z.gte(0), z.lte(1e10)),
  machine: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)),
  shift1: z.boolean(),
  shift2: z.boolean(),
  shift3: z.boolean(),
});

const userIds = z
  .optional(z.array(z.string().check(z.minLength(1), z.maxLength(100))).check(z.maxLength(50)))
  .transform((v) => [...new Set(v ?? [])]);

// THE CREATE / UPDATE / PREVIEW BODY — one shape for all three, which is what
// makes "preview then save" a re-run of the same resolution rather than a second
// validator that can drift from the first.
const jobBodySchema = z
  .object({
    startDate: civilDate,
    endDate: civilDate,
    rollYield: percent,
    bagYield: percent,
    wdToday: percent,
    rwPersonnel: headcount,
    twPersonnel: headcount,
    overtime: z.nullish(z.number().check(z.gte(0), z.lte(1e6))).transform((v) => v ?? null),
    overtimeUnit: z
      .nullish(z.enum(["HOUR_PER_GROUP", "PERSON_PER_HOUR"]))
      .transform((v) => v ?? null),
    notes: z
      .nullish(z.string().check(z.trim(), z.maxLength(2000)))
      .transform((v) => (v === undefined || v === null || v === "" ? null : v)),
    managerIds: userIds,
    foremanIds: userIds,
    afaIds: userIds,
    // At least one row. A job with no plan would sit in the Table and nowhere
    // else — no block on the calendar, no bar on the Gantt.
    plan: z.array(rawPlanRowSchema).check(z.minLength(1), z.maxLength(MAX_PLAN_ROWS)),
  })
  .check(
    z.refine((v) => v.endDate >= v.startDate, {
      error: "`endDate` must not be before `startDate`",
      path: ["endDate"],
    }),
  )
  .check(
    z.refine((v) => spanDays(v.startDate, v.endDate) < MAX_JOB_DAYS, {
      error: `a job may cover at most ${MAX_JOB_DAYS} days`,
      path: ["endDate"],
    }),
  )
  .check(
    // BOTH OR NEITHER — the table's jobs_overtime_pair CHECK, with a message.
    z.refine((v) => (v.overtime === null) === (v.overtimeUnit === null), {
      error: "overtime needs a unit, and a unit needs an amount",
      path: ["overtimeUnit"],
    }),
  );

const jobValidator = {
  listJobs: queryValidator(listJobsSchema),
  listShifts: queryValidator(listShiftsSchema),
  listPlan: queryValidator(listPlanSchema),
  listActivity: queryValidator(listActivitySchema),
  listUsers: queryValidator(listUsersSchema),
  write: jsonValidator(jobBodySchema),
};

type JobBody = z.infer<typeof jobBodySchema>;
type ListJobsQuery = z.infer<typeof listJobsSchema>;

export {
  MAX_GANTT_DAYS,
  MAX_JOB_DAYS,
  MAX_PLAN_ROWS,
  MAX_WINDOW_DAYS,
  jobBodySchema,
  jobValidator,
  listActivitySchema,
  listJobsSchema,
  listPlanSchema,
  listShiftsSchema,
  listUsersSchema,
};
export type { JobBody, ListJobsQuery };
