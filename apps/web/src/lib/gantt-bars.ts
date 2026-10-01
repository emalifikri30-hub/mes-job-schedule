import type { PlanItem, PlanRow, ShiftNumber } from "@/lib/types";

// THE GANTT'S ARITHMETIC — slots, bars, lanes and totals — as pure functions.
//
// The Gantt component knows about pixels; this knows about plan rows. Keeping
// the rules here is what lets them be tested one by one, and there are three
// that each produce a plausible, wrong chart if they drift:
//
// ─────────────────────────────────────────────────────────────────────────────
// 1. A SLOT IS ONE SHIFT OF ONE DAY, and the columns are the window's days x 3.
// ─────────────────────────────────────────────────────────────────────────────
//
//            Fri 25        Sat 26        Sun 27
//          1   2   3     1   2   3     1   2   3
//   slot   0   1   2     3   4   5     6   7   8
//
// Friday's shift 3 is slot 2 — FRIDAY's column, the business date — even though
// most of its hours are on Saturday's clock. The Gantt is a plan, read by shift
// number; the Calendar is the view that draws clock hours.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2. A BAR IS A MAXIMAL RUN OF CONTIGUOUS TICKED SLOTS (decision 9A)
// ─────────────────────────────────────────────────────────────────────────────
//
// for one (job, machine, SKU, unit). It may cross days — Friday 1-2-3 and
// Saturday 1-2-3 are one bar of six — and a gap splits it:
//
//   Fri row: v v v   Sat row: v . v   ->   slots 0 1 2 3 . 5
//                                          [■ ■ ■ ■]   [■]
//                                           bar A      bar B
//
// NEVER ACROSS JOBS: two jobs that happen to touch are two plans with two
// people responsible, and one bar would claim they are one. NEVER ACROSS SKUS
// or UNITS, for the reason rule 3 gives.
//
// ─────────────────────────────────────────────────────────────────────────────
// 3. A ROW'S TARGET COUNTS ONCE, TOWARD THE BAR HOLDING ITS FIRST TICKED SHIFT
// ─────────────────────────────────────────────────────────────────────────────
//
// A row's target is per DAY across every shift ticked on it, and is never split
// between shifts. So when a gap puts one row's shifts in two bars (Saturday
// above: shifts 1 and 3), the row's target must go to exactly ONE of them —
// counting it in both would double the plan on screen. The FIRST ticked shift
// decides: in the example, Saturday's whole target lands in bar A, and bar B
// shows only what rows STARTING in it carry (here, nothing: "SKU A · 0").
//
// TOTALS ARE PER SKU PER UNIT and never summed across units. 400 CARTON plus
// 50 KG is not 450 of anything, and a line total that added them would be a
// number nobody can check against the floor.

const SHIFTS_PER_DAY = 3;

type GanttBar = {
  key: string;
  jobId: number;
  workUnitId: number;
  productId: number;
  productName: string;
  unit: string | null;
  // [startSlot, endSlot) — half-open, like every window in this codebase.
  startSlot: number;
  endSlot: number;
  target: number;
  // Which of the row's stacked lanes the bar sits in. Two SKUs planned on one
  // machine in the same shift overlap, and drawing them on top of each other
  // would hide one.
  lane: number;
};

type GanttMachineRow = {
  workUnitId: number;
  workUnitName: string;
  bars: GanttBar[];
  laneCount: number;
};

type SkuTotal = {
  productId: number;
  productName: string;
  unit: string | null;
  total: number;
};

type GanttLineGroup = {
  workCenterId: number;
  workCenterName: string;
  machines: GanttMachineRow[];
  // Per SKU per unit, across the line's machines, over the window.
  totals: SkuTotal[];
};

function slotOf(dayIndex: number, shift: ShiftNumber): number {
  return dayIndex * SHIFTS_PER_DAY + (shift - 1);
}

// The unit a quantity is printed in. The CODE, because a bar has room for
// "CTN" and not always for "Carton"; the name only when there is no code.
// NULL — a machine with no good_output count point — prints the number bare,
// never with a guessed unit.
function unitOf(row: Pick<PlanRow, "uomCode" | "uomName">): string | null {
  return row.uomCode ?? row.uomName ?? null;
}

function tickedShifts(row: Pick<PlanRow, "shift1" | "shift2" | "shift3">): ShiftNumber[] {
  const out: ShiftNumber[] = [];
  if (row.shift1) out.push(1);
  if (row.shift2) out.push(2);
  if (row.shift3) out.push(3);
  return out;
}

const QUANTITY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

// "400 CARTON", or a bare "400" with no unit.
function formatQuantity(total: number, unit: string | null): string {
  const n = QUANTITY.format(total);
  return unit === null ? n : `${n} ${unit}`;
}

// "SKU A · 400 CARTON".
function formatSkuQuantity(productName: string, total: number, unit: string | null): string {
  return `${productName} · ${formatQuantity(total, unit)}`;
}

// Per SKU per unit. Shared with the Create Job confirmation, which states the
// same totals per line and per machine before anything is saved — so the
// numbers a planner confirmed are the numbers the Gantt then shows.
function totalsBySkuUnit(rows: PlanRow[]): SkuTotal[] {
  const out = new Map<string, SkuTotal>();
  for (const row of rows) {
    const unit = unitOf(row);
    const key = `${row.productId}|${unit ?? ""}`;
    const entry = out.get(key);
    if (entry === undefined) {
      out.set(key, {
        productId: row.productId,
        productName: row.productName,
        unit,
        total: row.target,
      });
    } else {
      entry.total += row.target;
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      a.productName.localeCompare(b.productName, undefined, { numeric: true }) ||
      (a.unit ?? "").localeCompare(b.unit ?? ""),
  );
}

// Rule 2 and rule 3, for one (job, machine, SKU, unit).
function barsFor(items: { item: PlanItem; slots: number[] }[]): Omit<GanttBar, "lane">[] {
  const first = items[0]!.item;
  const slots = [...new Set(items.flatMap((i) => i.slots))].sort((a, b) => a - b);

  const runs: { startSlot: number; endSlot: number; target: number }[] = [];
  for (const slot of slots) {
    const last = runs.at(-1);
    if (last !== undefined && last.endSlot === slot) last.endSlot = slot + 1;
    else runs.push({ startSlot: slot, endSlot: slot + 1, target: 0 });
  }

  // Rule 3: each row's target, ONCE, into the run holding its first slot.
  for (const { item, slots: itemSlots } of items) {
    const firstSlot = Math.min(...itemSlots);
    const run = runs.find((r) => firstSlot >= r.startSlot && firstSlot < r.endSlot);
    if (run !== undefined) run.target += item.target;
  }

  const unit = unitOf(first);
  return runs.map((run) => ({
    key: `${first.jobId}-${first.workUnitId}-${first.productId}-${unit ?? ""}-${run.startSlot}`,
    jobId: first.jobId,
    workUnitId: first.workUnitId,
    productId: first.productId,
    productName: first.productName,
    unit,
    ...run,
  }));
}

// Greedy lane assignment: first lane already free, else a new one. Sorted by
// start so the result is stable between renders.
function assignLanes(bars: Omit<GanttBar, "lane">[]): { bars: GanttBar[]; laneCount: number } {
  const sorted = [...bars].sort(
    (a, b) => a.startSlot - b.startSlot || a.jobId - b.jobId || a.productId - b.productId,
  );
  const laneEnds: number[] = [];
  const out: GanttBar[] = [];
  for (const bar of sorted) {
    let lane = laneEnds.findIndex((end) => end <= bar.startSlot);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.endSlot);
    } else {
      laneEnds[lane] = bar.endSlot;
    }
    out.push({ ...bar, lane });
  }
  return { bars: out, laneCount: Math.max(1, laneEnds.length) };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

// The whole chart: lines -> machines -> lane-assigned bars, plus line totals.
//
// Rows outside the window are DROPPED, not clipped: the server was asked for
// the window, and a row from outside it would have no column to be drawn in.
function buildGantt(items: PlanItem[], days: string[]): GanttLineGroup[] {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const inWindow = items.filter((item) => dayIndex.has(item.planDate));

  const lines = new Map<
    number,
    {
      name: string;
      rows: PlanItem[];
      machines: Map<
        number,
        { name: string; groups: Map<string, { item: PlanItem; slots: number[] }[]> }
      >;
    }
  >();

  for (const item of inWindow) {
    const slots = tickedShifts(item).map((s) => slotOf(dayIndex.get(item.planDate)!, s));
    // A row with nothing ticked has nothing to draw; the server skips those at
    // save time, so this is belt and braces.
    if (slots.length === 0) continue;

    let line = lines.get(item.workCenterId);
    if (line === undefined) {
      line = { name: item.workCenterName, rows: [], machines: new Map() };
      lines.set(item.workCenterId, line);
    }
    line.rows.push(item);

    let machine = line.machines.get(item.workUnitId);
    if (machine === undefined) {
      machine = { name: item.workUnitName, groups: new Map() };
      line.machines.set(item.workUnitId, machine);
    }

    // The bar identity: job, machine (implied by the map), SKU and UNIT.
    const key = `${item.jobId}|${item.productId}|${unitOf(item) ?? ""}`;
    const group = machine.groups.get(key);
    if (group === undefined) machine.groups.set(key, [{ item, slots }]);
    else group.push({ item, slots });
  }

  return [...lines.entries()]
    .map(([workCenterId, line]) => ({
      workCenterId,
      workCenterName: line.name,
      totals: totalsBySkuUnit(line.rows),
      machines: [...line.machines.entries()]
        .map(([workUnitId, machine]) => ({
          workUnitId,
          workUnitName: machine.name,
          ...assignLanes([...machine.groups.values()].flatMap(barsFor)),
        }))
        .sort((a, b) => byName(a.workUnitName, b.workUnitName)),
    }))
    .sort((a, b) => byName(a.workCenterName, b.workCenterName));
}

export {
  SHIFTS_PER_DAY,
  buildGantt,
  formatQuantity,
  formatSkuQuantity,
  slotOf,
  tickedShifts,
  totalsBySkuUnit,
  unitOf,
};
export type { GanttBar, GanttLineGroup, GanttMachineRow, SkuTotal };
