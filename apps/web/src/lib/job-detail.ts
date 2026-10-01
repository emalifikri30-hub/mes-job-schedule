import { tickedShifts, totalsBySkuUnit, unitOf } from "@/lib/gantt-bars";

import type { SkuTotal } from "@/lib/gantt-bars";
import type { PlanRow, ShiftNumber } from "@/lib/types";

// THE JOB DETAIL'S PLAN, GROUPED THE WAY IT IS READ.
//
// A job spans a date RANGE (the Table prints "01 Oct – 10 Oct"), so the detail
// groups by the one thing a planner checks a plan against — the day:
//
//   Thu, 01 Oct 2026 · S1 S2 S3 · 2 lines · 3 machines · 4 SKUs
//     Molca Line 1                       SKU A · 400 CTN   SKU B · 100 CTN   ← line total
//       Packer N   SKU A  ■ ■ ■  ███████████░░░  200 CTN
//                  SKU B  ■ ■ □  ███░░░░░░░░░░░  100 CTN
//                         machine total           300 CTN                  ← machine total
//       Test 1     SKU A  □ ■ ■  ███████████░░░  200 CTN
//     Molca Line 2 …
//
// TOTALS ARE PER SKU PER UNIT — the same totalsBySkuUnit() the Gantt's line cells
// and the Confirm step use, so the number on the detail is the number on the
// Gantt. A line whose machines count in different finish-good units shows one
// total per unit, never a sum across them (`500 BAG + 12 CTN` is a wrong number).
//
// THE BAR IS A ROW'S SHARE OF ITS LINE'S DAY, IN ITS OWN UNIT. `share` is the
// row's target over the largest target on the same (date, line, unit). Scaled per
// unit because a bar compares lengths, and a carton bar beside a bag bar invites
// exactly the cross-unit comparison the totals refuse. Scaled per (date, line)
// because that is the box the eye compares within — a scale shared across the
// whole job would flatten every small line into slivers. A NULL unit is its own
// group: those numbers are only comparable to each other.
//
// NOTHING HERE DIVIDES A TARGET BY SHIFT. A row's target is the day's quantity
// across all its ticked shifts (api job.ts); the shift marks say WHEN, the bar
// and the number say HOW MUCH, and the two are never combined into a
// per-shift figure nobody planned.

type DetailRow = PlanRow & {
  // 0..1 of the largest target on the same (date, line, unit). 0 for a 0 target.
  share: number;
};

type MachineDetail = {
  workUnitId: number;
  workUnitName: string;
  rows: DetailRow[];
  totals: SkuTotal[];
};

type LineDetail = {
  workCenterId: number;
  workCenterName: string;
  machines: MachineDetail[];
  totals: SkuTotal[];
};

type DayDetail = {
  date: string;
  shifts: ShiftNumber[];
  lineCount: number;
  machineCount: number;
  skuCount: number;
  lines: LineDetail[];
};

type PlanOverview = {
  days: number;
  lines: number;
  machines: number;
  skus: number;
  rows: number;
};

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function groupBy<K, T>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list === undefined) out.set(k, [item]);
    else list.push(item);
  }
  return out;
}

function lineDetail(rows: PlanRow[]): LineDetail {
  // The per-unit maximum the bars scale against — see the header.
  const maxByUnit = new Map<string, number>();
  for (const row of rows) {
    const unit = unitOf(row) ?? "";
    maxByUnit.set(unit, Math.max(maxByUnit.get(unit) ?? 0, row.target));
  }

  const machines = [...groupBy(rows, (r) => r.workUnitId).entries()]
    .map(([workUnitId, machineRows]) => ({
      workUnitId,
      workUnitName: machineRows[0]!.workUnitName,
      rows: [...machineRows]
        .sort(
          (a, b) => byName(a.productName, b.productName) || byName(a.productCode, b.productCode),
        )
        .map((row) => {
          const max = maxByUnit.get(unitOf(row) ?? "") ?? 0;
          return { ...row, share: max === 0 ? 0 : row.target / max };
        }),
      totals: totalsBySkuUnit(machineRows),
    }))
    .sort((a, b) => byName(a.workUnitName, b.workUnitName));

  return {
    workCenterId: rows[0]!.workCenterId,
    workCenterName: rows[0]!.workCenterName,
    machines,
    totals: totalsBySkuUnit(rows),
  };
}

// The plan by date, then line, then machine. Dates ascending, names in natural
// order ("Line 2" before "Line 10").
function groupPlanByDate(plan: PlanRow[]): DayDetail[] {
  return [...groupBy(plan, (r) => r.planDate).entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayRows]) => ({
      date,
      shifts: ([1, 2, 3] as const).filter((s) => dayRows.some((r) => tickedShifts(r).includes(s))),
      lineCount: new Set(dayRows.map((r) => r.workCenterId)).size,
      machineCount: new Set(dayRows.map((r) => r.workUnitId)).size,
      skuCount: new Set(dayRows.map((r) => r.productId)).size,
      lines: [...groupBy(dayRows, (r) => r.workCenterId).values()]
        .map(lineDetail)
        .sort((a, b) => byName(a.workCenterName, b.workCenterName)),
    }));
}

// The headline counts over the whole job.
function planOverview(plan: PlanRow[]): PlanOverview {
  return {
    days: new Set(plan.map((r) => r.planDate)).size,
    lines: new Set(plan.map((r) => r.workCenterId)).size,
    machines: new Set(plan.map((r) => r.workUnitId)).size,
    skus: new Set(plan.map((r) => r.productId)).size,
    rows: plan.length,
  };
}

export { groupPlanByDate, planOverview };
export type { DayDetail, DetailRow, LineDetail, MachineDetail, PlanOverview };
