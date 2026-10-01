import { describe, expect, it } from "vite-plus/test";

import {
  buildGantt,
  formatQuantity,
  formatSkuQuantity,
  slotOf,
  totalsBySkuUnit,
} from "@/lib/gantt-bars";

import type { PlanItem } from "@/lib/types";

// THE GANTT'S THREE RULES — slots, runs, and where a row's target is counted.
// Each one, if it drifts, draws a chart that looks right and says something
// false about the plan, so each has its own block here.

const DAYS = ["2026-09-25", "2026-09-26", "2026-09-27"];

function item(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    jobId: 1,
    planDate: "2026-09-25",
    workCenterId: 1,
    workCenterName: "Line 1",
    workUnitId: 11,
    workUnitName: "Machine 1.1",
    productId: 100,
    productCode: "SKU-A",
    productName: "SKU A",
    target: 200,
    uomCode: "CARTON",
    uomName: "Carton",
    shift1: true,
    shift2: true,
    shift3: true,
    ...overrides,
  };
}

const barsOf = (items: PlanItem[]) =>
  buildGantt(items, DAYS).flatMap((line) => line.machines.flatMap((m) => m.bars));

describe("slots", () => {
  it("numbers three shifts per day, Friday's S3 in FRIDAY's column", () => {
    expect(slotOf(0, 1)).toBe(0);
    expect(slotOf(0, 3)).toBe(2);
    expect(slotOf(1, 1)).toBe(3);
  });
});

describe("runs", () => {
  it("MERGES contiguous shifts across days into one bar", () => {
    const bars = barsOf([item(), item({ planDate: "2026-09-26" })]);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ startSlot: 0, endSlot: 6, target: 400 });
  });

  it("SPLITS a row at a gap into two bars, counting its target ONCE, in the first", () => {
    // Saturday runs shifts 1 and 3 only. Its target is per DAY, never split
    // between shifts — so it goes, whole, to the bar holding shift 1.
    const bars = barsOf([
      item({ target: 200 }),
      item({ planDate: "2026-09-26", target: 50, shift2: false }),
    ]);
    expect(bars.map((b) => [b.startSlot, b.endSlot, b.target])).toEqual([
      [0, 4, 250],
      [5, 6, 0],
    ]);
    // Nothing double-counted: the bars add up to the plan.
    expect(bars.reduce((sum, b) => sum + b.target, 0)).toBe(250);
  });

  it("counts a row whose FIRST ticked shift opens a later bar in that later bar", () => {
    const bars = barsOf([
      item({ shift3: false }),
      item({ planDate: "2026-09-26", target: 70, shift1: false, shift2: false }),
    ]);
    expect(bars.map((b) => [b.startSlot, b.target])).toEqual([
      [0, 200],
      [5, 70],
    ]);
  });

  it("NEVER merges two jobs, even when their shifts touch", () => {
    // Two plans with two sets of people responsible; one bar would claim they
    // are one.
    const bars = barsOf([item({ jobId: 1 }), item({ jobId: 2, planDate: "2026-09-26" })]);
    expect(bars).toHaveLength(2);
    expect(new Set(bars.map((b) => b.jobId))).toEqual(new Set([1, 2]));
  });

  it("never merges different SKUs, and stacks them in lanes when they overlap", () => {
    const [line] = buildGantt(
      [item(), item({ productId: 200, productName: "SKU B", productCode: "SKU-B" })],
      DAYS,
    );
    const machine = line!.machines[0]!;
    expect(machine.bars).toHaveLength(2);
    expect(machine.laneCount).toBe(2);
    expect(new Set(machine.bars.map((b) => b.lane))).toEqual(new Set([0, 1]));
  });

  it("drops rows outside the window rather than drawing them nowhere", () => {
    expect(barsOf([item({ planDate: "2026-10-30" })])).toEqual([]);
  });
});

describe("line totals — per SKU PER UNIT, never across units", () => {
  it("sums a SKU across the line's machines", () => {
    const [line] = buildGantt(
      [item(), item({ workUnitId: 12, workUnitName: "Machine 1.2" })],
      DAYS,
    );
    expect(line!.totals).toEqual([
      { productId: 100, productName: "SKU A", unit: "CARTON", total: 400 },
    ]);
    expect(line!.machines).toHaveLength(2);
  });

  it("keeps two UNITS of one SKU apart — 400 CARTON plus 50 KG is not 450", () => {
    const totals = totalsBySkuUnit([
      item({ target: 400 }),
      item({ workUnitId: 12, target: 50, uomCode: "KG", uomName: "Kilogram" }),
    ]);
    expect(totals.map((t) => formatSkuQuantity(t.productName, t.total, t.unit))).toEqual([
      "SKU A · 400 CARTON",
      "SKU A · 50 KG",
    ]);
  });

  it("keeps different SKUs apart", () => {
    const totals = totalsBySkuUnit([
      item(),
      item({ productId: 200, productName: "SKU B", target: 30 }),
    ]);
    expect(totals.map((t) => [t.productName, t.total])).toEqual([
      ["SKU A", 200],
      ["SKU B", 30],
    ]);
  });
});

describe("a machine with no finish-good unit", () => {
  it("prints the number BARE, never with a guessed unit", () => {
    const [bar] = barsOf([item({ uomCode: null, uomName: null })]);
    expect(bar!.unit).toBeNull();
    expect(formatQuantity(bar!.target, bar!.unit)).toBe("200");
  });

  it("never merges a unitless row into a bar that has a unit", () => {
    const bars = barsOf([item(), item({ planDate: "2026-09-26", uomCode: null, uomName: null })]);
    expect(bars).toHaveLength(2);
  });
});

describe("ordering", () => {
  it("orders lines and machines by name, numerically", () => {
    const lines = buildGantt(
      [
        item({ workCenterId: 10, workCenterName: "Line 10" }),
        item({ workCenterId: 2, workCenterName: "Line 2" }),
      ],
      DAYS,
    );
    expect(lines.map((l) => l.workCenterName)).toEqual(["Line 2", "Line 10"]);
  });
});
