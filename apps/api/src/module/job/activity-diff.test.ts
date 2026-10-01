import { describe, expect, it } from "vite-plus/test";

import { civilLabel, diffJob, jobLabel } from "./activity-diff.js";

import type { Job, JobWrite, PlanRow } from "./job.js";

const planRow: PlanRow = {
  planDate: "2026-10-01",
  workCenterId: 10,
  workCenterName: "Line 1",
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
};

const header = {
  startDate: "2026-10-01",
  endDate: "2026-10-10",
  rollYield: 95,
  bagYield: null,
  wdToday: null,
  rwPersonnel: 3,
  twPersonnel: null,
  overtime: 4,
  overtimeUnit: "HOUR_PER_GROUP" as const,
  notes: null,
  timeZone: "Asia/Jakarta",
};

const previous: Job = {
  ...header,
  id: 1,
  people: [
    { role: "MANAGER", userId: "u-1", userName: "Ayu" },
    { role: "MANAGER", userId: "u-2", userName: "Budi" },
  ],
  plan: [planRow],
  createdById: "kc",
  createdByName: null,
  createdAt: "",
  updatedById: null,
  updatedByName: null,
  updatedAt: null,
};

function next(overrides: Partial<JobWrite> = {}): JobWrite {
  return {
    ...header,
    people: previous.people,
    plan: previous.plan,
    actorId: "kc",
    actorName: null,
    ...overrides,
  };
}

describe("diffJob", () => {
  it("returns nothing when nothing moved", () => {
    expect(diffJob(previous, next())).toEqual([]);
  });

  it("words each field the way an operator reads it", () => {
    expect(
      diffJob(
        previous,
        next({
          rollYield: 97,
          overtime: 2,
          overtimeUnit: "PERSON_PER_HOUR",
          endDate: "2026-10-12",
        }),
      ),
    ).toEqual([
      { field: "Date", from: "01 Oct 2026 – 10 Oct 2026", to: "01 Oct 2026 – 12 Oct 2026" },
      { field: "Roll yield", from: "95%", to: "97%" },
      { field: "Overtime/shift", from: "4 h/group", to: "2 person/hour" },
    ]);
  });

  it("does not report the same people in a different order", () => {
    expect(diffJob(previous, next({ people: [...previous.people].reverse() }))).toEqual([]);
  });

  it("does not report the same plan in a different row order", () => {
    const other = { ...planRow, productId: 1001, productCode: "SKU-B" };
    const withTwo = { ...previous, plan: [planRow, other] };
    expect(diffJob(withTwo, next({ plan: [other, planRow] }))).toEqual([]);
  });

  it("summarises a plan change by size, not row by row", () => {
    const changes = diffJob(
      previous,
      next({ plan: [planRow, { ...planRow, planDate: "2026-10-02" }] }),
    );
    expect(changes).toEqual([
      { field: "Plan", from: "1 rows · 1 line · 1 machine", to: "2 rows · 1 line · 1 machine" },
    ]);
  });

  // Same size, different content: the summary alone would say "no change".
  it("says the contents were replaced when the size did not move", () => {
    const changes = diffJob(previous, next({ plan: [{ ...planRow, target: 300 }] }));
    expect(changes[0]!.to).toContain("(contents replaced)");
  });
});

describe("labels", () => {
  it("reads civil dates from the string, never through Date", () => {
    expect(civilLabel("2026-12-31")).toBe("31 Dec 2026");
  });

  it("names a one-day job by its single date", () => {
    expect(jobLabel(3, "2026-10-01", "2026-10-01")).toBe("Job #3 · 01 Oct 2026");
  });
});
