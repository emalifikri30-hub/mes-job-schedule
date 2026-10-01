import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { planItemsKey } from "@/lib/queries";
import { GanttView } from "@/components/job/gantt-view";

import type { PlanItem } from "@/lib/types";

// WHICH STATE THE GANTT SELECTS. The bar arithmetic is lib/gantt-bars.test.ts;
// what is asserted here is that the grid survives every state, that a clipped
// range and a truncated answer are both SAID, and that a bar opens the job's
// read-only detail on its first day.

const api = vi.hoisted(() => ({ getPlanItems: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getPlanItems: api.getPlanItems,
}));

const FILTERS = { workCenterIds: [] as number[], workUnitIds: [] as number[] };
const RANGE = { from: "2026-09-25", to: "2026-09-27" };
// The inclusive range as the half-open window the request carries.
const KEY = planItemsKey({ from: "2026-09-25", to: "2026-09-28", ...FILTERS });

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

function setup(
  data?: { items: PlanItem[]; truncated: boolean },
  range = RANGE,
  onSelectBar?: (jobId: number, date: string) => void,
) {
  return renderWithQuery(
    <GanttView range={range} filters={FILTERS} timeZone="Asia/Jakarta" onSelectBar={onSelectBar} />,
    { seed: data === undefined ? [] : [{ queryKey: KEY, data }] },
  );
}

beforeEach(() => {
  api.getPlanItems.mockReset();
  api.getPlanItems.mockReturnValue(new Promise(() => {}));
});

describe("the grid is always drawn", () => {
  it("draws the days and their shift columns when NOTHING is planned", () => {
    setup({ items: [], truncated: false });

    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.getByText(/Fri 25/)).toBeTruthy();
    expect(screen.getByText("Sun 27")).toBeTruthy();
    // Three shift columns per day.
    expect(screen.getAllByLabelText("Shift 1")).toHaveLength(3);
    expect(screen.getByText(/nothing planned in this range/i)).toBeTruthy();
  });

  it("draws them while the first response is in flight", () => {
    setup();

    expect(screen.getByText(/Fri 25/)).toBeTruthy();
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it("draws them when the fetch FAILED, and says so loudly", async () => {
    api.getPlanItems.mockRejectedValue(new Error("upstream down"));
    setup();

    expect(await screen.findByText(/could not load the plan/i)).toBeTruthy();
    expect(screen.getByText(/Fri 25/)).toBeTruthy();
  });
});

describe("the plan", () => {
  it("draws a merged bar labelled SKU · target · unit, and the line's total", () => {
    setup({
      items: [item(), item({ planDate: "2026-09-26" })],
      truncated: false,
    });

    // One bar for two contiguous days, carrying both days' targets.
    expect(screen.getByRole("note", { name: /SKU A · 400 CARTON/ })).toBeTruthy();
    expect(screen.getAllByRole("note")).toHaveLength(1);
    // The line cell's per-SKU-per-unit total.
    expect(screen.getByText("Line 1")).toBeTruthy();
    expect(screen.getAllByText("SKU A · 400 CARTON").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Machine 1.1")).toBeTruthy();
  });

  it("prints a unitless target bare", () => {
    setup({ items: [item({ uomCode: null, uomName: null })], truncated: false });

    expect(screen.getByRole("note", { name: /SKU A · 200 ·/ })).toBeTruthy();
  });

  it("opens the job's detail on the bar's FIRST day when a bar is clicked", async () => {
    const onSelectBar = vi.fn();
    setup(
      { items: [item(), item({ planDate: "2026-09-26" })], truncated: false },
      RANGE,
      onSelectBar,
    );

    await userEvent.click(screen.getByRole("button", { name: /SKU A/ }));

    expect(onSelectBar).toHaveBeenCalledWith(1, "2026-09-25");
  });

  it("draws a bar that is not a button when there is no handler", () => {
    setup({ items: [item()], truncated: false });

    expect(screen.queryByRole("button", { name: /SKU A/ })).toBeNull();
  });
});

describe("nothing is cut silently", () => {
  it("says so when the range is longer than 31 days", () => {
    const long = { from: "2026-10-01", to: "2026-11-15" };
    setup(undefined, long);

    expect(screen.getByText(/showing the first 31 days/i)).toBeTruthy();
  });

  it("says so when the server truncated the plan", () => {
    setup({ items: [item()], truncated: true });

    expect(screen.getByText(/showing part of this plan/i)).toBeTruthy();
  });

  it("shows neither banner when nothing was cut", () => {
    setup({ items: [item()], truncated: false });

    expect(screen.queryByText(/showing the first/i)).toBeNull();
    expect(screen.queryByText(/showing part of/i)).toBeNull();
  });
});
