import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { jobsKey } from "@/lib/queries";
import { JobTable } from "@/components/job/job-table";

import type { JobSummary, PageMeta } from "@/lib/types";

// WHICH STATE THE TABLE SELECTS — pending, error, empty, populated — and the
// two things about a row that no pure function can check: Edit and Detail are
// wired, each to its own handler.

const api = vi.hoisted(() => ({ getJobs: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getJobs: api.getJobs,
}));

const FILTERS = { workCenterIds: [] as number[], workUnitIds: [] as number[] };

const KEY = jobsKey({ page: 1, size: 10, ...FILTERS });

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 12,
    startDate: "2026-09-23",
    endDate: "2026-09-25",
    rollYield: null,
    bagYield: null,
    wdToday: null,
    rwPersonnel: null,
    twPersonnel: null,
    overtime: null,
    overtimeUnit: null,
    notes: null,
    lineNames: ["Line 1"],
    planRowCount: 9,
    createdById: "kc-1",
    createdByName: "planner",
    createdAt: "2026-09-20T02:00:00.000Z",
    ...overrides,
  };
}

const META: PageMeta = {
  page: 1,
  size: 10,
  totalElements: 2,
  totalPages: 1,
  first: true,
  last: true,
};

function setup(seed?: { rows: JobSummary[]; meta: PageMeta }) {
  const onEdit = vi.fn();
  const onDetail = vi.fn();
  const view = renderWithQuery(
    <JobTable
      range={undefined}
      filters={FILTERS}
      page={1}
      size={10}
      onPageChange={() => {}}
      onSizeChange={() => {}}
      onEdit={onEdit}
      onDetail={onDetail}
    />,
    { seed: seed === undefined ? [] : [{ queryKey: KEY, data: seed }] },
  );
  return { onEdit, onDetail, ...view };
}

beforeEach(() => {
  api.getJobs.mockReset();
});

describe("state selection", () => {
  it("shows skeleton rows while the first page is in flight", () => {
    api.getJobs.mockReturnValue(new Promise(() => {}));
    const { container } = setup();

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/no jobs/i)).toBeNull();
  });

  it("says the request FAILED rather than showing an empty table", async () => {
    // An empty table after a failed fetch reads as "nothing is planned".
    api.getJobs.mockRejectedValue(new Error("upstream down"));
    setup();

    expect(await screen.findByText(/could not load jobs: upstream down/i)).toBeTruthy();
    expect(screen.queryByText(/no jobs/i)).toBeNull();
  });

  it("says so when there are no jobs", () => {
    setup({ rows: [], meta: { ...META, totalElements: 0, totalPages: 0 } });

    expect(screen.getByText(/no jobs yet/i)).toBeTruthy();
  });

  it("lists jobs when there are some", () => {
    setup({
      rows: [job(), job({ id: 13, startDate: "2026-09-21", endDate: "2026-09-21" })],
      meta: META,
    });

    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});

describe("the columns", () => {
  it("heads the table No | Date | Created By | Action", () => {
    setup({ rows: [job()], meta: META });

    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["No", "Date", "Created By", "Action"]);
  });

  it("prints the job's RANGE, and a single date for a one-day job", () => {
    setup({
      rows: [job(), job({ id: 13, startDate: "2026-09-21", endDate: "2026-09-21" })],
      meta: META,
    });

    expect(screen.getByText("Wed, 23 Sep 2026 – Fri, 25 Sep 2026")).toBeTruthy();
    expect(screen.getByText("Mon, 21 Sep 2026")).toBeTruthy();
  });

  it("falls back to the subject when the creator has no display name", () => {
    setup({ rows: [job({ createdByName: null })], meta: META });

    expect(screen.getByText("kc-1")).toBeTruthy();
  });
});

describe("the actions", () => {
  it("Edit opens the job", async () => {
    const { onEdit } = setup({ rows: [job()], meta: META });

    await userEvent.click(screen.getByRole("button", { name: "Edit job #12" }));

    expect(onEdit).toHaveBeenCalledWith(12);
  });

  // Two handlers, never one: a glance must not land in the edit form.
  it("Detail opens the read-only detail, not the edit form", async () => {
    const { onEdit, onDetail } = setup({ rows: [job()], meta: META });

    await userEvent.click(screen.getByRole("button", { name: "Detail of job #12" }));

    expect(onDetail).toHaveBeenCalledWith(12);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("puts the two actions side by side in one cell", () => {
    setup({ rows: [job()], meta: META });

    const cell = screen.getByRole("button", { name: "Edit job #12" }).closest("td");
    expect(within(cell as HTMLElement).getAllByRole("button")).toHaveLength(2);
  });
});
