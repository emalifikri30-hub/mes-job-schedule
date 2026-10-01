import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { JobDetailSheet } from "@/components/job/job-detail-sheet";

import type { Job, PlanRow } from "@/lib/types";

// WHICH STATE THE SHEET SELECTS (pending / error / populated), and what a pure
// function cannot check: that the header fields, the people and the plan land
// where a reader looks for them, that NULL reads as "not stated" rather than 0,
// and that the plan is grouped BY DATE with its totals per line and per machine.
// The grouping arithmetic itself is lib/job-detail.test.ts.

const api = vi.hoisted(() => ({ getJob: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getJob: api.getJob,
}));

function row(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    planDate: "2026-10-01",
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
    shift3: false,
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 12,
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    timeZone: "Asia/Jakarta",
    rollYield: 95,
    bagYield: null,
    wdToday: 70,
    rwPersonnel: 4,
    twPersonnel: null,
    overtime: 3,
    overtimeUnit: "HOUR_PER_GROUP",
    notes: "Trial run on Line 1",
    people: [
      { role: "MANAGER", userId: "u-1", userName: "Ayu Lestari" },
      { role: "FOREMAN", userId: "u-2", userName: "Budi" },
    ],
    plan: [
      row(),
      row({ productId: 101, productCode: "SKU-B", productName: "SKU B", target: 100 }),
      row({ workUnitId: 12, workUnitName: "Machine 1.2", target: 150, shift3: true }),
      row({ planDate: "2026-10-02", target: 300 }),
    ],
    createdById: "kc-1",
    createdByName: "planner",
    createdAt: "2026-09-20T02:00:00.000Z",
    updatedById: null,
    updatedByName: null,
    updatedAt: null,
    ...overrides,
  };
}

function setup(props: { focusDate?: string; seed?: Job } = {}, onEdit = vi.fn()) {
  // A background refetch (window focus on a click) must see the same job.
  if (props.seed !== undefined) api.getJob.mockResolvedValue(props.seed);
  const view = renderWithQuery(
    <JobDetailSheet
      jobId={12}
      focusDate={props.focusDate}
      open
      onOpenChange={() => {}}
      onEdit={onEdit}
    />,
    { seed: props.seed === undefined ? [] : [{ queryKey: ["job", 12], data: props.seed }] },
  );
  return { onEdit, ...view };
}

beforeEach(() => {
  api.getJob.mockReset();
});

describe("state selection", () => {
  it("shows skeletons while the job is in flight", () => {
    api.getJob.mockReturnValue(new Promise(() => {}));
    setup();

    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("says the request failed rather than drawing an empty job", async () => {
    api.getJob.mockRejectedValue(new Error("upstream down"));
    setup();

    expect(await screen.findByText("Could not load this job")).toBeTruthy();
    expect(screen.getByText("upstream down")).toBeTruthy();
  });

  it("names the job and its range, and who created it", () => {
    setup({ seed: job() });

    expect(screen.getByText("Job #12")).toBeTruthy();
    expect(screen.getByText("Thu, 1 Oct 2026 – Fri, 2 Oct 2026")).toBeTruthy();
    expect(screen.getByText(/Created by planner/)).toBeTruthy();
  });
});

describe("the header fields", () => {
  it("draws each yield as a 0–100 meter with its value", () => {
    setup({ seed: job() });

    const roll = screen.getByRole("meter", { name: "Roll Yield" });
    expect(roll.getAttribute("aria-valuenow")).toBe("95");
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "WD Today" }).getAttribute("aria-valuenow")).toBe(
      "70",
    );
  });

  // An empty meter would read as "0% yield" — a claim about the plant.
  it("draws NO meter for a yield nobody stated", () => {
    setup({ seed: job() });

    expect(screen.queryByRole("meter", { name: "Bag Yield" })).toBeNull();
    expect(screen.getAllByText("Not stated").length).toBeGreaterThanOrEqual(2);
  });

  it("prints personnel and overtime with their units in words", () => {
    setup({ seed: job() });

    const rw = screen.getByText("RW Personel").parentElement!;
    expect(within(rw).getByText("4")).toBeTruthy();
    expect(within(rw).getByText("person/shift")).toBeTruthy();
    const overtime = screen.getByText("Overtime/Shift").parentElement!;
    expect(within(overtime).getByText("h/group")).toBeTruthy();
  });

  it("shows the notes", () => {
    setup({ seed: job() });
    expect(screen.getByText("Trial run on Line 1")).toBeTruthy();
  });
});

describe("the people", () => {
  it("lists each role's people, and says so when a role has nobody", () => {
    setup({ seed: job() });

    const people = screen.getByRole("region", { name: "Assigned people" });
    expect(within(people).getByText("Ayu Lestari")).toBeTruthy();
    expect(within(people).getByText("Budi")).toBeTruthy();
    // AFA is empty.
    expect(within(people).getByText("No one assigned")).toBeTruthy();
  });
});

describe("the plan, grouped by date", () => {
  it("has one section per day of the plan, in date order", () => {
    setup({ seed: job() });

    const plan = screen.getByRole("region", { name: "Job plan" });
    const days = within(plan).getAllByRole("button", { name: /Oct 2026, \d+ line/ });
    expect(days.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Thu, 1 Oct 2026, 1 line",
      "Fri, 2 Oct 2026, 1 line",
    ]);
  });

  it("shows the line total per SKU, and the machine total where a machine runs two SKUs", () => {
    // Two days: both open, because a short job opens entirely.
    setup({ seed: job() });

    const firstDay = screen.getAllByRole("table", { name: /Line 1/ })[0]!;
    // Line 1 on 1 Oct: SKU A 200 + 150, SKU B 100.
    const lineBlock = firstDay.closest(".rounded-md") as HTMLElement;
    expect(within(lineBlock).getByText("SKU A · 350 CARTON")).toBeTruthy();
    expect(within(lineBlock).getByText("SKU B · 100 CARTON")).toBeTruthy();
    expect(
      within(firstDay).getByText(/Total: SKU A · 200 CARTON, SKU B · 100 CARTON/),
    ).toBeTruthy();
  });

  it("lists every machine with its running SKU, its shifts and its target", () => {
    setup({ seed: job() });

    const firstDay = screen.getAllByRole("table", { name: /Line 1/ })[0]!;
    const rows = within(firstDay).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("Machine 1.1")).toBeTruthy();
    expect(within(rows[0]!).getByText("SKU-A")).toBeTruthy();
    expect(within(rows[0]!).getByText("200 CARTON")).toBeTruthy();
    // Shifts 1 and 2 planned, 3 not — said in words, not by colour alone.
    expect(within(rows[0]!).getByRole("img", { name: "Shift 3 not planned" })).toBeTruthy();
    expect(within(rows[2]!).getByRole("img", { name: "Shift 3 planned" })).toBeTruthy();
  });

  // A long job opens only the day that was clicked.
  it("opens only the focused day of a long job, and can expand them all", async () => {
    const plan = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((planDate) =>
      row({ planDate }),
    );
    setup({ focusDate: "2026-10-03", seed: job({ endDate: "2026-10-04", plan }) });

    expect(screen.getAllByRole("table", { name: /Line 1/ })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Sat, 3 Oct 2026, 1 line" }).getAttribute("data-state"),
    ).toBe("open");

    await userEvent.click(screen.getByRole("button", { name: "Expand all days" }));
    expect(await screen.findAllByRole("table", { name: /Line 1/ })).toHaveLength(4);
  });
});

describe("a failed refresh", () => {
  // The job on screen is still true; only the refresh failed. Swapping it for an
  // error would hide a plan somebody is reading.
  it("keeps the loaded job and says the refresh failed", async () => {
    const { queryClient } = setup({ seed: job() });
    api.getJob.mockReset();
    api.getJob.mockRejectedValue(new Error("upstream down"));

    await act(() => queryClient.refetchQueries({ queryKey: ["job", 12] }));

    expect(await screen.findByText("Could not refresh this job")).toBeTruthy();
    expect(screen.getByText("Trial run on Line 1")).toBeTruthy();
  });
});

describe("edit", () => {
  it("hands off to the edit dialog from its own button", async () => {
    const { onEdit } = setup({ seed: job() });

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(onEdit).toHaveBeenCalledWith(12);
  });
});
