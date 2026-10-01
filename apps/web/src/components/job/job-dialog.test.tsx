import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/render";
import { PlanRejectedError } from "@/lib/api";
import { PLAN_HEADER } from "@/lib/job-plan-csv";
import { AreaProvider } from "@/components/layout/area-context";
import { JobDialog } from "@/components/job/job-dialog";

import type { JobRole, PlanPreview, PlanRow, RoleUser } from "@/lib/types";

// THE STATES THE DIALOG MUST SELECT, each one a way a plan could otherwise be
// lost or saved wrong:
//
//   a file with a syntax error   -> listed by row on the Plan step, NOTHING sent
//   a preview with issues        -> listed on Confirm, Confirm disabled
//   a save refused on the plan   -> BACK on Confirm with the new issues, not a
//                                   toast and a closed dialog (decision 15A)
//   a people picker that failed  -> its ERROR, never an empty list (14A)

const api = vi.hoisted(() => ({
  getRoleUsers: vi.fn(),
  previewPlan: vi.fn(),
  createJob: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getRoleUsers: api.getRoleUsers,
  previewPlan: api.previewPlan,
  createJob: api.createJob,
}));

const PEOPLE: Record<JobRole, RoleUser[]> = {
  MANAGER: [{ id: "u-1", name: "Mona Manager" }],
  FOREMAN: [{ id: "u-2", name: "Fred Foreman" }],
  AFA: [{ id: "u-3", name: "Ana AFA" }],
};

const ROW: PlanRow = {
  planDate: "2026-09-25",
  workCenterId: 10,
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
};

const CLEAN: PlanPreview = { rows: [ROW], issues: [], ignoredRows: 0 };

const GOOD_CSV = [PLAN_HEADER.join(";"), "25/09/2026;Line 1;SKU A;SKU-A;200;Machine 1.1;v;v;"].join(
  "\r\n",
);

function csvFile(text: string) {
  return new File([text], "plan.csv", { type: "text/csv" });
}

function setup() {
  const onOpenChange = vi.fn();
  renderWithQuery(
    <AreaProvider>
      <JobDialog
        open
        onOpenChange={onOpenChange}
        defaultRange={{ from: "2026-09-25", to: "2026-09-27" }}
      />
    </AreaProvider>,
    {
      seed: [
        { queryKey: ["areas"], data: [{ id: 1, code: "A", name: "Area" }] },
        { queryKey: ["work-centers", 1], data: [{ id: 10, code: "L1", name: "Line 1" }] },
      ],
    },
  );
  return { onOpenChange, user: userEvent.setup() };
}

async function toPlanStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText(/drop the plan csv here/i)).toBeTruthy();
}

async function upload(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.upload(screen.getByLabelText("Plan CSV file"), csvFile(text));
}

beforeEach(() => {
  api.getRoleUsers.mockReset();
  api.getRoleUsers.mockImplementation((role: JobRole) => Promise.resolve(PEOPLE[role]));
  api.previewPlan.mockReset();
  api.createJob.mockReset();
});

describe("step 1 — details", () => {
  it("refuses to move on with an end date before the start", async () => {
    const { user } = setup();

    const end = screen.getByLabelText(/end date/i);
    await user.clear(end);
    await user.type(end, "2026-09-20");
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(/before the start date/i)).toBeTruthy();
    expect(screen.queryByText(/drop the plan csv here/i)).toBeNull();
  });

  it("shows a people picker's ERROR rather than an empty list", async () => {
    // A 502 here is configuration — the role missing in the realm, a service
    // account without view-users. An empty picker would read as "nobody holds
    // this role", and the planner would save a job with no manager believing it.
    api.getRoleUsers.mockImplementation((role: JobRole) =>
      role === "MANAGER"
        ? Promise.reject(new Error("role job-manager not found in realm"))
        : Promise.resolve(PEOPLE[role]),
    );
    setup();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("role job-manager not found in realm");
    // The picker itself carries it too, and is not offering an empty list.
    const picker = screen.getByRole("combobox", { name: "Managers" });
    expect(picker.textContent).toContain("not found in realm");
    expect((picker as HTMLButtonElement).disabled).toBe(true);
    // The other two still work.
    expect((screen.getByRole("combobox", { name: "Foreman" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("step 2 — the plan file", () => {
  it("lists syntax errors BY ROW and sends nothing", async () => {
    const { user } = setup();
    await toPlanStep(user);

    await upload(
      user,
      [
        PLAN_HEADER.join(";"),
        "25/09/2026;Line 1;SKU A;SKU-A;200;Machine 1.1;v;;",
        "31/02/2026;Line 1;SKU A;SKU-A;x;M;v;;",
      ].join("\n"),
    );

    const list = await screen.findByRole("list", { name: "Plan issues" });
    expect(screen.getByText(/the file could not be read/i)).toBeTruthy();
    expect(within(list).getByText(/date: "31\/02\/2026" is not a date/)).toBeTruthy();
    expect(within(list).getAllByText("Row 2")).toHaveLength(2);
    // Syntax is the browser's job; a file that fails it never reaches preview.
    expect(api.previewPlan).not.toHaveBeenCalled();
  });

  it("names a comma-separated file for what it is", async () => {
    const { user } = setup();
    await toPlanStep(user);

    await upload(user, [PLAN_HEADER.join(","), "25/09/2026,Line 1,SKU A,SKU-A,1,M,v,,"].join("\n"));

    expect(await screen.findByText(/separated by commas/i)).toBeTruthy();
  });

  it("keeps Download template disabled until a line is chosen", async () => {
    const { user } = setup();
    await toPlanStep(user);

    const button = screen.getByRole("button", { name: /download template/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("step 3 — confirm", () => {
  it("shows the preview's issues against their rows, and will not save", async () => {
    api.previewPlan.mockResolvedValue({
      rows: [ROW],
      issues: [{ row: 2, field: "machine", message: '"Machine 9" is not on Line 1' }],
      ignoredRows: 0,
    } satisfies PlanPreview);
    const { user } = setup();
    await toPlanStep(user);

    await upload(user, GOOD_CSV);

    expect(await screen.findByText(/the plan has issues/i)).toBeTruthy();
    expect(screen.getByText(/machine: "Machine 9" is not on Line 1/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("summarises a clean plan by date, with totals per SKU per unit", async () => {
    api.previewPlan.mockResolvedValue(CLEAN);
    const { user } = setup();
    await toPlanStep(user);

    await upload(user, GOOD_CSV);

    expect(await screen.findByText("Fri, 25 Sep 2026 · Shift 1, 2")).toBeTruthy();
    expect(screen.getByText("SKU A (Machine 1.1)")).toBeTruthy();
    expect(screen.getAllByText(/SKU A · 200 CARTON/).length).toBeGreaterThan(0);
    // The preview was sent the PARSED rows, with the CSV's date converted.
    expect(api.previewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-09-25",
        plan: [expect.objectContaining({ row: 1, date: "2026-09-25", skuCode: "SKU-A" })],
      }),
      undefined,
    );
  });

  it("stays on Confirm with the NEW issues when the save is refused on the plan", async () => {
    // Master data changed, or another planner saved an overlapping job first.
    // Closing the dialog on a toast would throw the plan away.
    api.previewPlan.mockResolvedValue(CLEAN);
    api.createJob.mockRejectedValue(
      new PlanRejectedError(
        {
          rows: [ROW],
          issues: [
            { row: 1, field: "shift1", message: "Machine 1.1 is already planned in job #7" },
          ],
          ignoredRows: 0,
        },
        409,
      ),
    );
    const { user, onOpenChange } = setup();
    await toPlanStep(user);
    await upload(user, GOOD_CSV);

    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByText(/the job was not saved/i)).toBeTruthy();
    expect(screen.getByText(/already planned in job #7/)).toBeTruthy();
    expect(screen.getByText("Row 1")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("closes once the save succeeds", async () => {
    api.previewPlan.mockResolvedValue(CLEAN);
    api.createJob.mockResolvedValue({ id: 1 });
    const { user, onOpenChange } = setup();
    await toPlanStep(user);
    await upload(user, GOOD_CSV);

    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(api.createJob).toHaveBeenCalledTimes(1);
  });
});
