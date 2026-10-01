import { tickedShifts, totalsBySkuUnit } from "@/lib/gantt-bars";

import type { SkuTotal } from "@/lib/gantt-bars";
import type { PlanRow, ShiftNumber } from "@/lib/types";

// WHAT THE CONFIRM STEP SAYS BEFORE ANYTHING IS SAVED — the RESOLVED plan the
// preview returned, summarised the way a planner checks it:
//
//   Fri, 25 Sep 2026 · Shift 1, 2, 3 · Line 1, Line 2 · Machine 1.1, 2.1 · SKU A (Machine 1.1), …
//
// then the total target per line and per machine, PER SKU PER UNIT. The totals
// come from the same totalsBySkuUnit() the Gantt's line cells use, so the number
// a planner confirms is the number the Gantt then shows.
//
// Built from the PREVIEW's rows, never from the parsed CSV: those rows carry the
// names and units the server resolved, and a confirmation of the CSV's own text
// would be a confirmation of what was typed rather than of what will be saved.

type DaySummary = {
  date: string;
  shifts: ShiftNumber[];
  lines: string[];
  machines: string[];
  // "SKU A (Machine 1.1)" — the SKU with the machine it runs on, because the
  // same SKU on two machines is two lines of work.
  skus: string[];
};

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function unique(values: string[]): string[] {
  return [...new Set(values)].sort(byName);
}

function summariseByDate(rows: PlanRow[]): DaySummary[] {
  const days = new Map<string, PlanRow[]>();
  for (const row of rows) {
    const list = days.get(row.planDate);
    if (list === undefined) days.set(row.planDate, [row]);
    else list.push(row);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayRows]) => ({
      date,
      shifts: ([1, 2, 3] as const).filter((s) => dayRows.some((r) => tickedShifts(r).includes(s))),
      lines: unique(dayRows.map((r) => r.workCenterName)),
      machines: unique(dayRows.map((r) => r.workUnitName)),
      skus: unique(dayRows.map((r) => `${r.productName} (${r.workUnitName})`)),
    }));
}

type LineTotals = {
  workCenterId: number;
  workCenterName: string;
  totals: SkuTotal[];
  machines: { workUnitId: number; workUnitName: string; totals: SkuTotal[] }[];
};

function totalsByLineAndMachine(rows: PlanRow[]): LineTotals[] {
  const lines = new Map<number, PlanRow[]>();
  for (const row of rows) {
    const list = lines.get(row.workCenterId);
    if (list === undefined) lines.set(row.workCenterId, [row]);
    else list.push(row);
  }
  return [...lines.entries()]
    .map(([workCenterId, lineRows]) => {
      const machines = new Map<number, PlanRow[]>();
      for (const row of lineRows) {
        const list = machines.get(row.workUnitId);
        if (list === undefined) machines.set(row.workUnitId, [row]);
        else list.push(row);
      }
      return {
        workCenterId,
        workCenterName: lineRows[0]!.workCenterName,
        totals: totalsBySkuUnit(lineRows),
        machines: [...machines.entries()]
          .map(([workUnitId, machineRows]) => ({
            workUnitId,
            workUnitName: machineRows[0]!.workUnitName,
            totals: totalsBySkuUnit(machineRows),
          }))
          .sort((a, b) => byName(a.workUnitName, b.workUnitName)),
      };
    })
    .sort((a, b) => byName(a.workCenterName, b.workCenterName));
}

export { summariseByDate, totalsByLineAndMachine };
export type { DaySummary, LineTotals };
