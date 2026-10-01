import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import postgres from "postgres";

import { JobRepository } from "./job-repository.js";

import type { PostgresDB } from "../../shared/database/postgres.js";
import type { ActivityDraft } from "./job-repository.js";
import type { JobWrite, PlanRow } from "./job.js";

// INTEGRATION TESTS — a REAL Postgres, the REAL migrations.
//
// SKIPPED unless JOB_SCHEDULE_TEST_DATABASE_URL is set, so `vp test` stays green
// with no Docker. CI always runs them (.github/workflows/api.yaml starts a
// postgres service and applies the checked-in DDL with scripts/migrate.mjs).
//
// WHAT ONLY A REAL DATABASE CAN CATCH HERE:
//
//   · 0003 APPLIES ON TOP OF 0002 — the FK hand-over from `events` to `jobs`,
//     the renames, the CHECKs. None of it is exercised by a fake.
//   · THE CASTS. bigint and numeric come back as strings and dates as local
//     Dates unless cast; a fake returns whatever the test typed.
//   · THE WINDOW PREDICATES — the Table's inclusive-range overlap, the Calendar's
//     shift unpivot and its day-before shift 3, the Gantt's window.
//   · THE PLAN LOCK. Two overlapping saves at once, exactly one wins. A fake
//     cannot race.
//
// To run locally:
//
//   docker run --rm -d --name jobsched-pg -e POSTGRES_PASSWORD=postgres \
//     -e POSTGRES_DB=job_schedule -p 55432:5432 postgres:18-alpine
//   export JOB_SCHEDULE_DATABASE_URL=postgres://postgres:postgres@localhost:55432/job_schedule
//   export JOB_SCHEDULE_TEST_DATABASE_URL=$JOB_SCHEDULE_DATABASE_URL
//   node apps/api/scripts/migrate.mjs
//   pnpm --filter api exec vp test job-repository.integration

const url = process.env.JOB_SCHEDULE_TEST_DATABASE_URL;

const maybe = url === undefined ? describe.skip : describe;

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    planDate: "2026-10-01",
    workCenterId: 10,
    workCenterName: "Molca Line 1",
    workUnitId: 100,
    workUnitName: "Packer N",
    productId: 1000,
    productCode: "SKU-A",
    productName: "SKU A",
    target: 200.5,
    uomCode: "CTN",
    uomName: "CARTON",
    shift1: true,
    shift2: true,
    shift3: false,
    ...overrides,
  };
}

function write(overrides: Partial<JobWrite> = {}): JobWrite {
  return {
    startDate: "2026-10-01",
    endDate: "2026-10-10",
    timeZone: "Asia/Jakarta",
    rollYield: 95.5,
    bagYield: null,
    wdToday: null,
    rwPersonnel: 3,
    twPersonnel: null,
    overtime: 4,
    overtimeUnit: "HOUR_PER_GROUP",
    notes: null,
    people: [{ role: "MANAGER", userId: "u-1", userName: "Ayu" }],
    plan: [row()],
    actorId: "kc-sub-1",
    actorName: "planner",
    ...overrides,
  };
}

function created(): ActivityDraft {
  return {
    action: "CREATED",
    actorId: "kc-sub-1",
    actorName: "planner",
    changes: null,
    label: (id) => `Job #${id}`,
  };
}

async function mustCreate(repository: JobRepository, w: JobWrite): Promise<number> {
  const outcome = await repository.create(w, created());
  if (!outcome.ok) throw new Error(`unexpected conflict: ${JSON.stringify(outcome.conflicts)}`);
  return outcome.id;
}

const WINDOW = { workCenterIds: [] as number[], workUnitIds: [] as number[] };

maybe("JobRepository (integration)", () => {
  let sql: PostgresDB;
  let repository: JobRepository;

  beforeAll(() => {
    sql = postgres(url!, { max: 4, onnotice: () => {}, transform: postgres.camel });
    repository = new JobRepository({ jobDb: sql });
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    // activity_log is truncated EXPLICITLY: it is deliberately NOT part of the
    // jobs cascade, which is one of the things asserted below.
    await sql`TRUNCATE job_schedule.activity_log RESTART IDENTITY`;
    await sql`TRUNCATE job_schedule.jobs RESTART IDENTITY CASCADE`;
  });

  describe("the schema itself", () => {
    it("lives in job_schedule, with the maintenance tables gone", async () => {
      const rows = (await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'job_schedule' ORDER BY table_name
      `) as unknown as { tableName: string }[];
      expect(rows.map((r) => r.tableName)).toEqual([
        "activity_log",
        "job_people",
        "job_plan_items",
        "jobs",
        "schema_migrations",
      ]);
    });

    it("refuses overtime without a unit — the CHECK, not only the dto", async () => {
      await expect(
        sql`INSERT INTO job_schedule.jobs (start_date, end_date, time_zone, overtime, created_by_id)
            VALUES ('2026-10-01', '2026-10-02', 'UTC', 4, 'x')`,
      ).rejects.toThrow(/jobs_overtime_pair/);
    });

    it("refuses a plan row with no shift ticked", async () => {
      const id = await mustCreate(repository, write());
      await expect(
        sql`INSERT INTO job_schedule.job_plan_items
              (job_id, plan_date, work_center_id, work_center_name, work_unit_id, work_unit_name,
               product_id, product_code, product_name, target, shift1, shift2, shift3)
            VALUES (${id}, '2026-10-02', 1, 'L', 1, 'M', 1, 'P', 'P', 1, false, false, false)`,
      ).rejects.toThrow(/job_plan_items_some_shift/);
    });
  });

  describe("create and findById", () => {
    it("round-trips a job with every number a number and every date a string", async () => {
      const id = await mustCreate(repository, write());

      const job = await repository.findById(id);

      expect(job).toMatchObject({
        id,
        startDate: "2026-10-01",
        endDate: "2026-10-10",
        rollYield: 95.5,
        rwPersonnel: 3,
        overtime: 4,
        overtimeUnit: "HOUR_PER_GROUP",
        createdById: "kc-sub-1",
        people: [{ role: "MANAGER", userId: "u-1", userName: "Ayu" }],
      });
      expect(job!.plan).toEqual([row()]);
      expect(typeof job!.id).toBe("number");
    });

    it("writes the CREATED audit row in the same transaction, labelled with the new id", async () => {
      const id = await mustCreate(repository, write());

      const feed = await repository.listActivity(10);

      expect(feed).toEqual([
        expect.objectContaining({
          jobId: id,
          jobLabel: `Job #${id}`,
          action: "CREATED",
          changes: null,
        }),
      ]);
    });

    // The FK is SET NULL, not CASCADE: removing a job must not remove the
    // record that it existed.
    it("keeps the audit trail when a job row goes away", async () => {
      const id = await mustCreate(repository, write());
      await sql`DELETE FROM job_schedule.jobs WHERE id = ${id}`;

      const feed = await repository.listActivity(10);
      expect(feed).toEqual([expect.objectContaining({ jobId: null, jobLabel: `Job #${id}` })]);
    });

    it("inserts a plan larger than one statement's parameter budget", async () => {
      // 1,200 rows x 16 columns = 19,200 parameters; one INSERT of the 5,000 the
      // dto allows would be 80,000 and refused by the driver.
      const plan = Array.from({ length: 1_200 }, (_, i) =>
        row({ planDate: "2026-10-01", productId: 5_000 + i, productCode: `P-${i}` }),
      );
      const id = await mustCreate(repository, write({ plan }));

      const job = await repository.findById(id);
      expect(job!.plan).toHaveLength(1_200);
    });
  });

  describe("update", () => {
    it("replaces people and plan wholesale and stamps updated_by", async () => {
      const id = await mustCreate(repository, write());

      const outcome = await repository.update(
        id,
        write({
          people: [],
          plan: [row({ planDate: "2026-10-05" })],
          actorId: "kc-sub-2",
          actorName: "other",
        }),
        null,
      );

      expect(outcome).toEqual({ ok: true });
      const job = await repository.findById(id);
      expect(job!.people).toEqual([]);
      expect(job!.plan.map((r) => r.planDate)).toEqual(["2026-10-05"]);
      // The author is untouched.
      expect(job).toMatchObject({ createdById: "kc-sub-1", updatedById: "kc-sub-2" });
    });

    it("does not conflict with its own rows", async () => {
      const id = await mustCreate(repository, write());

      expect(await repository.update(id, write(), null)).toEqual({ ok: true });
    });

    it("reports not_found for a missing job", async () => {
      expect(await repository.update(999, write(), null)).toEqual({
        ok: false,
        reason: "not_found",
      });
    });
  });

  describe("conflicts between jobs", () => {
    it("finds the shared machine-date-shift, and only the shared shifts", async () => {
      const first = await mustCreate(repository, write());

      const conflicts = await repository.findConflicts(
        [row({ shift1: false, shift2: true, shift3: true })],
        null,
      );

      expect(conflicts).toEqual([
        { jobId: first, workUnitId: 100, planDate: "2026-10-01", shift: 2 },
      ]);
    });

    it("does not conflict on a different machine, date or shift", async () => {
      await mustCreate(repository, write());

      expect(await repository.findConflicts([row({ workUnitId: 101 })], null)).toEqual([]);
      expect(await repository.findConflicts([row({ planDate: "2026-10-02" })], null)).toEqual([]);
      expect(
        await repository.findConflicts([row({ shift1: false, shift2: false, shift3: true })], null),
      ).toEqual([]);
    });

    it("refuses a create that overlaps, writing nothing", async () => {
      await mustCreate(repository, write());

      const outcome = await repository.create(
        write({ plan: [row({ productId: 1001 })] }),
        created(),
      );

      expect(outcome.ok).toBe(false);
      const [{ value }] =
        (await sql`SELECT count(*)::int AS value FROM job_schedule.jobs`) as unknown as {
          value: number;
        }[];
      expect(value).toBe(1);
    });

    // THE RACE the plan lock exists for. Without the advisory lock both
    // transactions check, see nothing, and both commit.
    it("lets exactly one of two simultaneous overlapping saves win", async () => {
      const outcomes = await Promise.all([
        repository.create(write(), created()),
        repository.create(write({ plan: [row({ productId: 1001 })] }), created()),
      ]);

      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      expect(outcomes.filter((o) => !o.ok)).toHaveLength(1);
      const [{ value }] =
        (await sql`SELECT count(*)::int AS value FROM job_schedule.jobs`) as unknown as {
          value: number;
        }[];
      expect(value).toBe(1);
    });
  });

  describe("the window reads", () => {
    it("lists jobs whose inclusive range overlaps the half-open window, newest first", async () => {
      const early = await mustCreate(
        repository,
        write({
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          plan: [row({ planDate: "2026-09-01" })],
        }),
      );
      const late = await mustCreate(repository, write());

      // [2026-09-30, 2026-10-01) touches only the early job's LAST day.
      const edge = await repository.listJobs({
        from: "2026-09-30",
        to: "2026-10-01",
        page: 1,
        size: 10,
        ...WINDOW,
      });
      expect(edge.items.map((j) => j.id)).toEqual([early]);

      const all = await repository.listJobs({ page: 1, size: 10, ...WINDOW });
      expect(all.items.map((j) => j.id)).toEqual([late, early]);
      expect(all.totalElements).toBe(2);
      expect(all.items[0]).toMatchObject({ lineNames: ["Molca Line 1"], planRowCount: 1 });
    });

    it("pages with a stable total", async () => {
      for (let day = 1; day <= 3; day++) {
        const date = `2026-10-0${day}`;
        await mustCreate(
          repository,
          write({ startDate: date, endDate: date, plan: [row({ planDate: date })] }),
        );
      }

      const page2 = await repository.listJobs({ page: 2, size: 2, ...WINDOW });
      expect(page2.items).toHaveLength(1);
      expect(page2.totalElements).toBe(3);
    });

    it("filters jobs by line and by machine", async () => {
      await mustCreate(repository, write());

      const byLine = await repository.listJobs({
        page: 1,
        size: 10,
        workCenterIds: [99],
        workUnitIds: [],
      });
      expect(byLine.totalElements).toBe(0);
      const byMachine = await repository.listJobs({
        page: 1,
        size: 10,
        workCenterIds: [],
        workUnitIds: [100],
      });
      expect(byMachine.totalElements).toBe(1);
    });

    it("aggregates the Calendar's blocks per job, date and TICKED shift", async () => {
      await mustCreate(
        repository,
        write({
          plan: [
            row(),
            row({ productId: 1001, productCode: "SKU-B" }),
            row({
              workUnitId: 101,
              workUnitName: "Test 1",
              shift1: false,
              shift2: false,
              shift3: true,
            }),
          ],
        }),
      );

      const blocks = await repository.listShiftBlocks(
        { from: "2026-10-01", to: "2026-10-02", ...WINDOW },
        100,
      );

      expect(blocks.map((b) => [b.planDate, b.shift, b.machineCount, b.skuCount])).toEqual([
        ["2026-10-01", 1, 1, 2],
        ["2026-10-01", 2, 1, 2],
        ["2026-10-01", 3, 1, 1],
      ]);
      expect(blocks[0]).toMatchObject({ timeZone: "Asia/Jakarta", lineNames: ["Molca Line 1"] });
    });

    // Shift 3 of the day before the window runs into its first morning.
    it("includes the previous day's shift 3, and only its shift 3", async () => {
      await mustCreate(
        repository,
        write({
          plan: [row({ planDate: "2026-10-01", shift1: true, shift2: true, shift3: true })],
        }),
      );

      const blocks = await repository.listShiftBlocks(
        { from: "2026-10-02", to: "2026-10-03", ...WINDOW },
        100,
      );

      expect(blocks.map((b) => [b.planDate, b.shift])).toEqual([["2026-10-01", 3]]);
    });

    it("counts only the filtered machines in a block", async () => {
      await mustCreate(
        repository,
        write({ plan: [row(), row({ workUnitId: 101, workUnitName: "Test 1" })] }),
      );

      const blocks = await repository.listShiftBlocks(
        { from: "2026-10-01", to: "2026-10-02", workCenterIds: [], workUnitIds: [101] },
        100,
      );

      expect(blocks.every((b) => b.machineCount === 1)).toBe(true);
    });

    it("asks for cap + 1 rows so the service can tell it was truncated", async () => {
      await mustCreate(
        repository,
        write({ plan: [row({ shift1: true, shift2: true, shift3: true })] }),
      );

      const blocks = await repository.listShiftBlocks(
        { from: "2026-10-01", to: "2026-10-02", ...WINDOW },
        1,
      );
      expect(blocks).toHaveLength(2);
    });

    it("returns the Gantt's plan rows in the window with their job id", async () => {
      const id = await mustCreate(
        repository,
        write({ plan: [row(), row({ planDate: "2026-10-05" })] }),
      );

      const items = await repository.listPlanItems(
        { from: "2026-10-01", to: "2026-10-02", ...WINDOW },
        100,
      );

      expect(items).toEqual([{ jobId: id, ...row() }]);
    });
  });
});
