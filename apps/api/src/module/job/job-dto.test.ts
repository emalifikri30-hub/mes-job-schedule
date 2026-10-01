import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";

import {
  MAX_PLAN_ROWS,
  jobBodySchema,
  listJobsSchema,
  listPlanSchema,
  listShiftsSchema,
} from "./job-dto.js";

// SHAPE ONLY — meaning (which line, which machine) is job-service.test.ts. Each
// case is a body that would otherwise reach the service and either fail
// confusingly there or, worse, be written.

const row = {
  row: 1,
  date: "2026-10-01",
  line: "Molca Line 1",
  sku: "SKU A",
  skuCode: "SKU-A",
  target: 200,
  machine: "Packer N",
  shift1: true,
  shift2: false,
  shift3: true,
};

const valid = { startDate: "2026-10-01", endDate: "2026-10-10", plan: [row] };

function parse(body: unknown) {
  return z.safeParse(jobBodySchema, body);
}

describe("jobBodySchema", () => {
  it("accepts the minimal body and defaults every optional field to null or []", () => {
    const result = parse(valid);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      rollYield: null,
      overtime: null,
      overtimeUnit: null,
      notes: null,
      managerIds: [],
    });
  });

  it("rejects a date the calendar does not have", () => {
    expect(parse({ ...valid, plan: [{ ...row, date: "2026-02-30" }] }).success).toBe(false);
  });

  it("rejects an end before the start", () => {
    expect(parse({ ...valid, endDate: "2026-09-30" }).success).toBe(false);
  });

  it("allows a one-day job", () => {
    expect(parse({ ...valid, endDate: "2026-10-01" }).success).toBe(true);
  });

  it("caps a job at 62 days", () => {
    expect(parse({ ...valid, endDate: "2026-12-01" }).success).toBe(true);
    expect(parse({ ...valid, endDate: "2026-12-02" }).success).toBe(false);
  });

  it("rejects a percentage above 100", () => {
    expect(parse({ ...valid, bagYield: 100 }).success).toBe(true);
    expect(parse({ ...valid, bagYield: 100.5 }).success).toBe(false);
  });

  it("rejects a fractional headcount", () => {
    expect(parse({ ...valid, rwPersonnel: 2.5 }).success).toBe(false);
  });

  // "4" is four hours per group or four person-hours — never both, never neither.
  it("requires overtime and its unit together", () => {
    expect(parse({ ...valid, overtime: 4 }).success).toBe(false);
    expect(parse({ ...valid, overtimeUnit: "HOUR_PER_GROUP" }).success).toBe(false);
    expect(parse({ ...valid, overtime: 4, overtimeUnit: "HOUR_PER_GROUP" }).success).toBe(true);
  });

  it("treats a blank note as no note", () => {
    expect(parse({ ...valid, notes: "   " }).data?.notes).toBeNull();
  });

  it("requires at least one plan row and caps the plan", () => {
    expect(parse({ ...valid, plan: [] }).success).toBe(false);
    const tooMany = Array.from({ length: MAX_PLAN_ROWS + 1 }, (_, i) => ({ ...row, row: i + 1 }));
    expect(parse({ ...valid, plan: tooMany }).success).toBe(false);
  });

  it("rejects a negative target", () => {
    expect(parse({ ...valid, plan: [{ ...row, target: -1 }] }).success).toBe(false);
  });

  it("de-duplicates repeated people", () => {
    expect(parse({ ...valid, managerIds: ["u-1", "u-1"] }).data?.managerIds).toEqual(["u-1"]);
  });
});

describe("window queries", () => {
  it("parses comma-separated id lists, and treats empty as no filter", () => {
    const parsed = z.parse(listShiftsSchema, {
      from: "2026-09-21",
      to: "2026-09-28",
      workCenterIds: "1, 2,2",
      workUnitIds: "",
    });
    expect(parsed.workCenterIds).toEqual([1, 2]);
    expect(parsed.workUnitIds).toEqual([]);
  });

  it("rejects a malformed id list rather than dropping the bad id", () => {
    expect(
      z.safeParse(listShiftsSchema, { from: "2026-09-21", to: "2026-09-28", workCenterIds: "1,x" })
        .success,
    ).toBe(false);
  });

  it("caps the Gantt window at 31 days and the Calendar's at 400", () => {
    expect(z.safeParse(listPlanSchema, { from: "2026-10-01", to: "2026-11-01" }).success).toBe(
      true,
    );
    expect(z.safeParse(listPlanSchema, { from: "2026-10-01", to: "2026-11-02" }).success).toBe(
      false,
    );
    expect(z.safeParse(listShiftsSchema, { from: "2026-01-01", to: "2027-01-01" }).success).toBe(
      true,
    );
  });

  it("rejects an empty or inverted window", () => {
    expect(z.safeParse(listShiftsSchema, { from: "2026-10-01", to: "2026-10-01" }).success).toBe(
      false,
    );
  });
});

describe("listJobsSchema", () => {
  it("defaults to page 1 of 10 with no range", () => {
    expect(z.parse(listJobsSchema, {})).toMatchObject({ page: 1, size: 10 });
  });

  it("requires from and to together", () => {
    expect(z.safeParse(listJobsSchema, { from: "2026-10-01" }).success).toBe(false);
  });

  it("caps the page size at 100", () => {
    expect(z.safeParse(listJobsSchema, { size: "101" }).success).toBe(false);
  });
});
