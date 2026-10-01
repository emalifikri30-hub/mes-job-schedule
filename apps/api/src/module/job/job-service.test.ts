import { describe, expect, it, vi } from "vite-plus/test";
import { HTTPException } from "hono/http-exception";

import { JobService, MAX_SHIFT_BLOCKS, PlanRejectedError, mapBounded } from "./job-service.js";

import type { JobBody } from "./job-dto.js";
import type { Job, PlanRow, RawPlanRow } from "./job.js";
import type { PlanConflict, ShiftBlockRow } from "./job-repository.js";

// THE RESOLUTION, against fakes.
//
// Master data is a hand-rolled fake shaped like the sample plant: two areas,
// three lines, machines by name, SKUs by code. Every rule in the service's
// header diagram has a case here, because every one of them, skipped, writes a
// plan that renders correctly and means something wrong.
//
//   area 1 ─ line 10 "Molca Line 1" ─ machines 100 "Packer N", 101 "Test 1"
//          │                         products 1000 SKU-A, 1001 SKU-B
//          └ line 11 "Molca Line 2" ─ machine 110 "Packer L"
//                                    products 1000 SKU-A
//   area 2 ─ line 20 "Molca Line 2" (same name, other area — only reachable by
//            a test that asks for ambiguity)

const ACTOR = { subject: "kc-sub-1", name: "planner", roles: [] };

type Fakes = {
  lines?: { areaId: number; id: number; name: string }[];
  countPoints?: Record<number, { role: string; uom: { code: string; name: string } | null }[]>;
  conflicts?: PlanConflict[];
  roleUsers?: Record<string, { id: string; name: string }[]>;
};

function setup(fakes: Fakes = {}) {
  const lines = fakes.lines ?? [
    { areaId: 1, id: 10, name: "Molca Line 1" },
    { areaId: 1, id: 11, name: "Molca Line 2" },
  ];
  const rosters: Record<number, { id: number; code: string; name: string }[]> = {
    10: [
      { id: 100, code: "M-100", name: "Packer N" },
      { id: 101, code: "M-101", name: "Test 1" },
    ],
    11: [{ id: 110, code: "M-110", name: "Packer L" }],
    20: [{ id: 200, code: "M-200", name: "Packer L" }],
  };
  const products: Record<number, { id: number; code: string; name: string }[]> = {
    10: [
      { id: 1000, code: "SKU-A", name: "SKU A" },
      { id: 1001, code: "SKU-B", name: "SKU B" },
    ],
    11: [{ id: 1000, code: "SKU-A", name: "SKU A" }],
    20: [],
  };
  const countPoints = fakes.countPoints ?? {
    100: [{ role: "good_output", uom: { code: "CTN", name: "CARTON" } }],
    101: [{ role: "infeed", uom: { code: "BAG", name: "BAG" } }],
    110: [{ role: "good_output", uom: { code: "CTN", name: "CARTON" } }],
  };

  const masterData = {
    listAreas: vi.fn(async () =>
      [...new Set(lines.map((l) => l.areaId))].map((id) => ({
        id,
        code: `A${id}`,
        name: `Area ${id}`,
      })),
    ),
    listWorkCenters: vi.fn(async (areaId: number) =>
      lines
        .filter((l) => l.areaId === areaId)
        .map(({ id, name }) => ({ id, code: `L${id}`, name })),
    ),
    listWorkUnits: vi.fn(async (lineId: number) => rosters[lineId] ?? []),
    listLineProducts: vi.fn(async (lineId: number) => products[lineId] ?? []),
    listCountPoints: vi.fn(async (unitId: number) =>
      (countPoints[unitId] ?? []).map((p, i) => ({
        id: i + 1,
        role: p.role,
        uom: p.uom === null ? null : { id: i + 1, ...p.uom },
      })),
    ),
  };

  const repository = {
    findConflicts: vi.fn(async () => fakes.conflicts ?? []),
    create: vi.fn(async (..._args: unknown[]) => ({ ok: true as const, id: 42 })),
    update: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
    findById: vi.fn(async (id: number) => job({ id })),
    listShiftBlocks: vi.fn(async () => [] as ShiftBlockRow[]),
    listPlanItems: vi.fn(async () => []),
    listJobs: vi.fn(),
    listActivity: vi.fn(),
  };

  const roleUsers = fakes.roleUsers ?? {
    MANAGER: [{ id: "u-1", name: "Ayu Lestari" }],
    FOREMAN: [{ id: "u-2", name: "Budi" }],
    AFA: [{ id: "u-3", name: "Citra" }],
  };
  const userService = {
    listRoleUsers: vi.fn(async (role: string) => roleUsers[role] ?? []),
  };

  const timeZoneResolver = { resolve: vi.fn(async () => "Asia/Jakarta") };

  const service = new JobService({
    jobRepository: repository as never,
    masterDataService: masterData as never,
    timeZoneResolver: timeZoneResolver as never,
    userService: userService as never,
  });
  return { service, masterData, repository, userService, timeZoneResolver };
}

let nextRow = 1;
function raw(overrides: Partial<RawPlanRow> = {}): RawPlanRow {
  return {
    row: nextRow++,
    date: "2026-10-01",
    line: "Molca Line 1",
    sku: "SKU A",
    skuCode: "SKU-A",
    target: 200,
    machine: "Packer N",
    shift1: true,
    shift2: true,
    shift3: true,
    ...overrides,
  };
}

function body(plan: RawPlanRow[], overrides: Partial<JobBody> = {}): JobBody {
  return {
    startDate: "2026-10-01",
    endDate: "2026-10-10",
    rollYield: null,
    bagYield: null,
    wdToday: null,
    rwPersonnel: null,
    twPersonnel: null,
    overtime: null,
    overtimeUnit: null,
    notes: null,
    managerIds: [],
    foremanIds: [],
    afaIds: [],
    plan,
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 42,
    startDate: "2026-10-01",
    endDate: "2026-10-10",
    timeZone: "Asia/Jakarta",
    rollYield: null,
    bagYield: null,
    wdToday: null,
    rwPersonnel: null,
    twPersonnel: null,
    overtime: null,
    overtimeUnit: null,
    notes: null,
    people: [],
    plan: [],
    createdById: "kc-sub-1",
    createdByName: "planner",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedById: null,
    updatedByName: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("JobService.preview — resolving rows", () => {
  it("resolves a clean row to ids, frozen names and the machine's finish-good unit", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw({ row: 1 })]));

    expect(preview.issues).toEqual([]);
    expect(preview.rows).toEqual([
      {
        planDate: "2026-10-01",
        workCenterId: 10,
        workCenterName: "Molca Line 1",
        workUnitId: 100,
        workUnitName: "Packer N",
        productId: 1000,
        productCode: "SKU-A",
        productName: "SKU A",
        target: 200,
        uomCode: "CTN",
        uomName: "CARTON",
        shift1: true,
        shift2: true,
        shift3: true,
      } satisfies PlanRow,
    ]);
  });

  // A planner's spreadsheet is not a database: trailing spaces and case must not
  // make a real line "unknown".
  it("matches line and machine names ignoring case and extra spaces", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ line: "  molca   LINE 1 ", machine: "packer n " })]),
    );

    expect(preview.issues).toEqual([]);
    expect(preview.rows[0]!.workUnitId).toBe(100);
  });

  it("skips rows with no shift ticked, counting them rather than erroring", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw(), raw({ skuCode: "SKU-B", shift1: false, shift2: false, shift3: false })]),
    );

    expect(preview.issues).toEqual([]);
    expect(preview.rows).toHaveLength(1);
    expect(preview.ignoredRows).toBe(1);
  });

  it("reports a plan with nothing ticked at all as an issue, not an empty save", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ shift1: false, shift2: false, shift3: false })]),
    );

    expect(preview.issues).toEqual([
      { row: 0, field: "plan", message: "no row has a shift ticked" },
    ]);
  });

  it("rejects a date outside the job's range, naming it as the planner typed it", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw({ row: 7, date: "2026-10-11" })]));

    expect(preview.issues).toEqual([
      { row: 7, field: "date", message: "11/10/2026 is outside the job's date range" },
    ]);
    expect(preview.rows).toEqual([]);
  });

  it("rejects an unknown line", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw({ row: 3, line: "Molca Line 99" })]));

    expect(preview.issues[0]).toMatchObject({ row: 3, field: "line" });
    expect(preview.issues[0]!.message).toContain("unknown line");
  });

  // Two areas each with a "Molca Line 2": a guess would plan the wrong plant.
  it("rejects a line name that exists in two areas as ambiguous", async () => {
    const { service } = setup({
      lines: [
        { areaId: 1, id: 11, name: "Molca Line 2" },
        { areaId: 2, id: 20, name: "Molca Line 2" },
      ],
    });

    const preview = await service.preview(
      body([raw({ line: "Molca Line 2", machine: "Packer L" })]),
    );

    expect(preview.issues[0]).toMatchObject({ field: "line" });
    expect(preview.issues[0]!.message).toContain("matches 2 lines");
  });

  // THE CASE A BROWSER CANNOT RULE OUT: the machine exists, on another line.
  it("rejects a machine that is not on the row's line", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw({ row: 4, machine: "Packer L" })]));

    expect(preview.issues).toEqual([
      { row: 4, field: "machine", message: 'machine "Packer L" is not on line "Molca Line 1"' },
    ]);
  });

  it("rejects a SKU code not assigned to the line", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ row: 5, line: "Molca Line 2", machine: "Packer L", skuCode: "SKU-B" })]),
    );

    expect(preview.issues).toEqual([
      {
        row: 5,
        field: "skuCode",
        message: 'SKU code "SKU-B" is not assigned to line "Molca Line 2"',
      },
    ]);
  });

  // Matching on the CODE is what lets two products share a name — the sample
  // plant has two called "SKU Line 9F".
  it("matches the SKU on its code and ignores the name column", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ sku: "anything at all", skuCode: "SKU-B" })]),
    );

    expect(preview.issues).toEqual([]);
    expect(preview.rows[0]).toMatchObject({ productId: 1001, productName: "SKU B" });
  });

  it("rejects a second row for the same date, machine and SKU, pointing at the first", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ row: 1 }), raw({ row: 2, target: 50, shift1: false })]),
    );

    expect(preview.issues).toEqual([
      { row: 2, field: "skuCode", message: "duplicates row 1 (same date, machine and SKU)" },
    ]);
  });

  // Several SKUs on one machine on one day is the TEMPLATE's normal shape —
  // it lists every pair — and must stay legal.
  it("allows several SKUs on one machine on one day", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw(), raw({ skuCode: "SKU-B" })]));

    expect(preview.issues).toEqual([]);
    expect(preview.rows).toHaveLength(2);
  });

  it("reports every bad row, not only the first", async () => {
    const { service } = setup();

    const preview = await service.preview(
      body([raw({ row: 1, line: "nope" }), raw({ row: 2, machine: "nope" }), raw({ row: 3 })]),
    );

    expect(preview.issues.map((i) => i.row)).toEqual([1, 2]);
    expect(preview.rows).toHaveLength(1);
  });

  it("reads each line's roster and products once, however many rows name it", async () => {
    const { service, masterData } = setup();

    await service.preview(
      body([raw({ date: "2026-10-01" }), raw({ date: "2026-10-02" }), raw({ date: "2026-10-03" })]),
    );

    // The service caches per line; what matters here is that resolution asks
    // per MACHINE for units, not per row.
    expect(masterData.listCountPoints).toHaveBeenCalledTimes(1);
  });
});

describe("JobService.preview — the finish-good unit", () => {
  it("leaves the unit NULL when the machine has no good_output point", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw({ machine: "Test 1" })]));

    expect(preview.rows[0]).toMatchObject({ uomCode: null, uomName: null });
  });

  // Two good_output points in different units: the target has no single unit,
  // and showing it under the first one's would be a wrong number that looks fine.
  it("leaves the unit NULL when the machine's good_output points disagree", async () => {
    const { service } = setup({
      countPoints: {
        100: [
          { role: "good_output", uom: { code: "CTN", name: "CARTON" } },
          { role: "good_output", uom: { code: "BOX", name: "BOX" } },
        ],
      },
    });

    const preview = await service.preview(body([raw()]));

    expect(preview.rows[0]!.uomCode).toBeNull();
  });

  it("uses the unit when several good_output points agree", async () => {
    const { service } = setup({
      countPoints: {
        100: [
          { role: "good_output", uom: { code: "CTN", name: "CARTON" } },
          { role: "good_output", uom: { code: "CTN", name: "CARTON" } },
        ],
      },
    });

    const preview = await service.preview(body([raw()]));

    expect(preview.rows[0]!.uomCode).toBe("CTN");
  });
});

describe("JobService.preview — people", () => {
  it("does not ask Keycloak when nobody was chosen", async () => {
    const { service, userService } = setup();

    await service.preview(body([raw()]));

    expect(userService.listRoleUsers).not.toHaveBeenCalled();
  });

  // THE CHECK A PICKER CANNOT REPLACE: a hand-written body naming anybody.
  it("rejects a chosen id that does not hold the role", async () => {
    const { service } = setup();

    const preview = await service.preview(body([raw()], { managerIds: ["u-1", "u-2"] }));

    expect(preview.issues).toEqual([
      { row: 0, field: "managerIds", message: "user u-2 does not hold the MANAGER role" },
    ]);
  });

  it("passes a Keycloak failure through rather than reporting nobody holds the role", async () => {
    const { service, userService } = setup();
    userService.listRoleUsers.mockRejectedValueOnce(
      new HTTPException(502, { message: "service account lacks view-users" }),
    );

    await expect(service.preview(body([raw()], { foremanIds: ["u-2"] }))).rejects.toThrow(
      "view-users",
    );
  });
});

describe("JobService.preview — conflicts with other jobs", () => {
  it("reports another job's claim against the CSV row, per clashing shift", async () => {
    const { service } = setup({
      conflicts: [{ jobId: 12, workUnitId: 100, planDate: "2026-10-01", shift: 2 }],
    });

    const preview = await service.preview(body([raw({ row: 9 })]));

    expect(preview.issues).toEqual([
      {
        row: 9,
        field: "shift2",
        message: '"Packer N" on 01/10/2026 shift 2 is already planned in job #12',
      },
    ]);
  });

  // A conflict reported against a row that is already wrong is noise.
  it("does not look for conflicts while rows are still wrong", async () => {
    const { service, repository } = setup();

    await service.preview(body([raw({ line: "nope" }), raw({ skuCode: "SKU-B" })]));

    expect(repository.findConflicts).not.toHaveBeenCalled();
  });

  it("excludes the job being edited from its own conflicts", async () => {
    const { service, repository } = setup();

    await service.preview(body([raw()]), 42);

    expect(repository.findConflicts).toHaveBeenCalledWith(expect.any(Array), 42);
  });
});

describe("JobService.create", () => {
  it("writes the resolved plan, the people and the zone, stamped with the actor", async () => {
    const { service, repository } = setup();

    await service.create(body([raw()], { managerIds: ["u-1"] }), ACTOR);

    const [write, activity] = repository.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { action: string; changes: unknown; label: (id: number) => string },
    ];
    expect(write).toMatchObject({
      timeZone: "Asia/Jakarta",
      actorId: "kc-sub-1",
      actorName: "planner",
      people: [{ role: "MANAGER", userId: "u-1", userName: "Ayu Lestari" }],
    });
    expect((write.plan as PlanRow[])[0]!.workUnitId).toBe(100);
    // NULL, not []: there is no "before".
    expect(activity).toMatchObject({ action: "CREATED", changes: null });
    expect(activity.label(42)).toBe("Job #42 · 01 Oct 2026 – 10 Oct 2026");
  });

  it("refuses a plan with issues with the preview's shape and a 400", async () => {
    const { service, repository } = setup();

    const err = await service.create(body([raw({ line: "nope" })]), ACTOR).catch((e) => e);

    expect(err).toBeInstanceOf(PlanRejectedError);
    expect((err as PlanRejectedError).status).toBe(400);
    expect((err as PlanRejectedError).preview.issues[0]!.field).toBe("line");
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("answers 409 when the only issues are other jobs' claims", async () => {
    const { service } = setup({
      conflicts: [{ jobId: 12, workUnitId: 100, planDate: "2026-10-01", shift: 1 }],
    });

    const err = (await service.create(body([raw()]), ACTOR).catch((e) => e)) as PlanRejectedError;

    expect(err.status).toBe(409);
  });

  // THE RACE: the unlocked check saw nothing, another job was saved in between,
  // and the locked check inside the transaction caught it.
  it("turns a conflict found under the lock into the same 409 shape", async () => {
    const { service, repository } = setup();
    repository.create.mockResolvedValueOnce({
      ok: false,
      conflicts: [{ jobId: 13, workUnitId: 100, planDate: "2026-10-01", shift: 3 }],
    } as never);

    const err = (await service
      .create(body([raw({ row: 6 })]), ACTOR)
      .catch((e) => e)) as PlanRejectedError;

    expect(err).toBeInstanceOf(PlanRejectedError);
    expect(err.status).toBe(409);
    expect(err.preview.issues).toEqual([
      expect.objectContaining({ row: 6, field: "shift3", message: expect.stringContaining("#13") }),
    ]);
  });

  // Master data moved between Preview and Save. Save re-resolves rather than
  // trusting the preview, and answers in the same shape.
  it("re-resolves on save, so a machine moved since the preview is refused", async () => {
    const { service, masterData } = setup();
    expect((await service.preview(body([raw()]))).issues).toEqual([]);

    masterData.listWorkUnits.mockImplementation(async () => []);

    const err = (await service.create(body([raw()]), ACTOR).catch((e) => e)) as PlanRejectedError;
    expect(err).toBeInstanceOf(PlanRejectedError);
    expect(err.preview.issues[0]!.field).toBe("machine");
  });
});

describe("JobService.update", () => {
  it("404s before any master-data work when the job does not exist", async () => {
    const { service, repository, masterData } = setup();
    repository.findById.mockResolvedValueOnce(undefined as never);

    await expect(service.update(99, body([raw()]), ACTOR)).rejects.toThrow("job not found");
    expect(masterData.listAreas).not.toHaveBeenCalled();
  });

  it("writes no audit row when nothing changed", async () => {
    const { service, repository } = setup();
    const unchanged = (await service.preview(body([raw()]))).rows;
    repository.findById.mockResolvedValue(job({ plan: unchanged }));

    await service.update(42, body([raw()]), ACTOR);

    expect(repository.update).toHaveBeenCalledWith(42, expect.any(Object), null);
  });

  it("records the worded diff when something did", async () => {
    const { service, repository } = setup();
    repository.findById.mockResolvedValue(job({ plan: [] }));

    await service.update(42, body([raw()], { rollYield: 97 }), ACTOR);

    const activity = repository.update.mock.calls[0]![2] as unknown as {
      changes: { field: string }[];
    };
    expect(activity.changes.map((c) => c.field)).toEqual(["Roll yield", "Plan"]);
  });
});

describe("JobService.listShiftBlocks", () => {
  it("builds each block's instants from the plan's zone, shift 3 ending the next day", async () => {
    const { service, repository } = setup();
    repository.listShiftBlocks.mockResolvedValueOnce([
      {
        jobId: 1,
        planDate: "2026-09-25",
        shift: 3,
        timeZone: "Asia/Jakarta",
        lineNames: ["Molca Line 1"],
        lineCount: 1,
        machineCount: 2,
        skuCount: 3,
      },
    ]);

    const { blocks, truncated } = await service.listShiftBlocks({
      from: "2026-09-21",
      to: "2026-09-28",
      workCenterIds: [],
      workUnitIds: [],
    });

    expect(truncated).toBe(false);
    expect(blocks[0]).toMatchObject({
      occurrenceDate: "2026-09-25",
      startsAt: "2026-09-25T16:00:00.000Z",
      endsAt: "2026-09-26T00:00:00.000Z",
    });
  });

  it("says so when the answer hit the cap, and returns exactly the cap", async () => {
    const { service, repository } = setup();
    const row: ShiftBlockRow = {
      jobId: 1,
      planDate: "2026-09-25",
      shift: 1,
      timeZone: "Asia/Jakarta",
      lineNames: [],
      lineCount: 0,
      machineCount: 0,
      skuCount: 0,
    };
    repository.listShiftBlocks.mockResolvedValueOnce(
      Array.from({ length: MAX_SHIFT_BLOCKS + 1 }, () => row),
    );

    const { blocks, truncated } = await service.listShiftBlocks({
      from: "2026-09-21",
      to: "2026-09-28",
      workCenterIds: [],
      workUnitIds: [],
    });

    expect(truncated).toBe(true);
    expect(blocks).toHaveLength(MAX_SHIFT_BLOCKS);
  });
});

describe("mapBounded", () => {
  it("never runs more than the limit at once and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapBounded([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });
});
