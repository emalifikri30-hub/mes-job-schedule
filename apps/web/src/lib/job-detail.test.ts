import { describe, expect, it } from "vite-plus/test";

import { groupPlanByDate, planOverview } from "./job-detail";

import type { PlanRow } from "./types";

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    planDate: "2026-10-01",
    workCenterId: 1,
    workCenterName: "Line 1",
    workUnitId: 11,
    workUnitName: "Machine 1.1",
    productId: 100,
    productCode: "A",
    productName: "SKU A",
    target: 200,
    uomCode: "CTN",
    uomName: "CARTON",
    shift1: true,
    shift2: true,
    shift3: true,
    ...overrides,
  };
}

describe("groupPlanByDate", () => {
  it("groups a multi-day job by date, ascending, then line, then machine", () => {
    const days = groupPlanByDate([
      row({ planDate: "2026-10-02" }),
      row(),
      row({ workCenterId: 2, workCenterName: "Line 10", workUnitId: 21, workUnitName: "M 10" }),
      row({ workCenterId: 3, workCenterName: "Line 2", workUnitId: 31, workUnitName: "M 2" }),
      row({ workUnitId: 12, workUnitName: "Machine 1.2" }),
    ]);

    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    // Natural order: "Line 2" before "Line 10".
    expect(days[0]!.lines.map((l) => l.workCenterName)).toEqual(["Line 1", "Line 2", "Line 10"]);
    expect(days[0]!.lines[0]!.machines.map((m) => m.workUnitName)).toEqual([
      "Machine 1.1",
      "Machine 1.2",
    ]);
  });

  it("counts the day's shifts, lines, machines and SKUs", () => {
    const [day] = groupPlanByDate([
      row({ shift1: true, shift2: false, shift3: false }),
      row({ productId: 101, shift1: false, shift2: false, shift3: true }),
      row({ workUnitId: 12, workUnitName: "M2", shift1: true, shift2: false, shift3: false }),
    ]);

    expect(day).toMatchObject({ shifts: [1, 3], lineCount: 1, machineCount: 2, skuCount: 2 });
  });

  it("totals per machine and per line, per SKU", () => {
    const [day] = groupPlanByDate([
      row({ target: 200 }),
      row({ productId: 101, productCode: "B", productName: "SKU B", target: 100 }),
      row({ workUnitId: 12, workUnitName: "Machine 1.2", target: 150 }),
    ]);
    const line = day!.lines[0]!;

    expect(line.totals).toEqual([
      { productId: 100, productName: "SKU A", unit: "CTN", total: 350 },
      { productId: 101, productName: "SKU B", unit: "CTN", total: 100 },
    ]);
    expect(line.machines[0]!.totals.map((t) => t.total)).toEqual([200, 100]);
  });

  // A carton and a bag are never added together.
  it("keeps one total per unit when machines on a line count in different units", () => {
    const [day] = groupPlanByDate([
      row({ target: 200 }),
      row({ workUnitId: 12, workUnitName: "M2", target: 50, uomCode: "BAG", uomName: "BAG" }),
    ]);

    expect(day!.lines[0]!.totals).toEqual([
      { productId: 100, productName: "SKU A", unit: "BAG", total: 50 },
      { productId: 100, productName: "SKU A", unit: "CTN", total: 200 },
    ]);
  });

  it("scales each bar against the largest target of the same line, day and unit", () => {
    const [day] = groupPlanByDate([
      row({ target: 200 }),
      row({ productId: 101, target: 50 }),
      // Its own unit: its own scale, so it is a full bar at 10.
      row({ workUnitId: 12, workUnitName: "Machine 1.2", target: 10, uomCode: "BAG" }),
    ]);
    const [first, second] = day!.lines[0]!.machines;

    expect(first!.rows.map((r) => r.share)).toEqual([1, 0.25]);
    expect(second!.rows[0]!.share).toBe(1);
  });

  it("gives a zero target a zero bar rather than NaN", () => {
    const [day] = groupPlanByDate([row({ target: 0 })]);
    expect(day!.lines[0]!.machines[0]!.rows[0]!.share).toBe(0);
  });

  it("scales per day: the same row is a full bar on a quiet day", () => {
    const days = groupPlanByDate([
      row({ target: 100 }),
      row({ productId: 101, target: 400 }),
      row({ planDate: "2026-10-02", target: 100 }),
    ]);
    expect(days[1]!.lines[0]!.machines[0]!.rows[0]!.share).toBe(1);
  });
});

describe("planOverview", () => {
  it("counts distinct days, lines, machines and SKUs across the job", () => {
    expect(
      planOverview([
        row(),
        row({ planDate: "2026-10-02", productId: 101 }),
        row({ workCenterId: 2, workUnitId: 21 }),
      ]),
    ).toEqual({ days: 2, lines: 2, machines: 2, skus: 2, rows: 3 });
  });
});
