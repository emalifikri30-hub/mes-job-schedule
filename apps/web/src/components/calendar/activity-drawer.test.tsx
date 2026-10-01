import { describe, expect, it } from "vite-plus/test";
import { screen, within } from "@testing-library/react";

import { renderWithQuery } from "@/test/render";
import { ACTIVITY_PAGE_SIZE, activityKey } from "@/lib/queries";
import { ActivityDrawer } from "@/components/calendar/activity-drawer";

import type { ActivityEntry } from "@/lib/types";

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 1,
    jobId: 5,
    jobLabel: "Job #5 · 01 Oct – 10 Oct 2026",
    action: "CREATED",
    actorId: "kc-sub-1",
    actorName: "operator",
    at: "2026-09-21T02:30:00.000Z",
    changes: null,
    ...overrides,
  };
}

// An infinite query's cache shape. Seeding it directly keeps these tests about
// what the drawer RENDERS rather than about fetching.
function seedFeed(pages: ActivityEntry[][]) {
  return {
    queryKey: activityKey,
    data: { pages, pageParams: pages.map((_, i) => (i === 0 ? undefined : i)) },
  };
}

function setup(pages?: ActivityEntry[][], open = true) {
  return renderWithQuery(<ActivityDrawer open={open} onOpenChange={() => {}} />, {
    seed: pages === undefined ? [] : [seedFeed(pages)],
  });
}

describe("state selection", () => {
  it("renders skeletons while there is no data", () => {
    // The query is gated on `open`, and a gated query reports
    // `status: "pending"` FOREVER — so a component branching on `isPending`
    // first would show a skeleton that never resolves in the common case where
    // the drawer has never been opened. This asserts the branch is on DATA.
    setup(undefined);

    expect(screen.queryByText(/no activity yet/i)).toBeNull();
    expect(screen.queryByText("Job #5 · 01 Oct – 10 Oct 2026")).toBeNull();
  });

  it("says so when the log is empty", () => {
    setup([[]]);

    expect(screen.getByText(/no activity yet/i)).toBeTruthy();
  });

  it("lists entries when there are some", () => {
    setup([[entry()]]);

    expect(screen.getByText("Job #5 · 01 Oct – 10 Oct 2026")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
  });
});

describe("what an entry says", () => {
  it("names the actor and an ABSOLUTE timestamp", () => {
    // Not "3 hours ago": an audit trail is read to establish when something
    // happened, and a relative time cannot be compared against a shift record.
    setup([[entry()]]);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/operator/)).toBeTruthy();
    // Locale-formatted, so the assertion is on the YEAR rather than on a format
    // this test would otherwise pin to one machine's locale. Matched on the
    // actor line, because the job label carries a year too.
    expect(within(row).getByText(/operator · .*2026/)).toBeTruthy();
  });

  it("falls back to the subject when the display name is absent", () => {
    // `actorName` is display-only and nullable; the durable identity is the
    // subject. Rendering "null" would be worse than rendering the id.
    setup([[entry({ actorName: null })]]);

    expect(screen.getByText(/kc-sub-1/)).toBeTruthy();
  });

  it("labels each action", () => {
    setup([
      [
        entry({ id: 1, action: "CREATED" }),
        entry({ id: 2, action: "UPDATED", changes: [] }),
        entry({ id: 3, action: "DELETED", jobId: null }),
      ],
    ]);

    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Updated")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
  });
});

describe("deleted jobs", () => {
  it("KEEPS them in the log and marks them", () => {
    // THE CASE THE AUDIT TRAIL EXISTS FOR. The server keeps the row when the
    // job goes (ON DELETE SET NULL, not CASCADE); filtering it out here would
    // throw away the single most important thing the log records.
    setup([[entry({ action: "DELETED", jobId: null, jobLabel: "Job #3 · 01 Sep – 02 Sep 2026" })]]);

    expect(screen.getByText("Job #3 · 01 Sep – 02 Sep 2026")).toBeTruthy();
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });

  it("does not mark an entry whose job is still there", () => {
    setup([[entry({ jobId: 5 })]]);

    expect(screen.queryByText(/no longer exists/i)).toBeNull();
  });
});

describe("the diff", () => {
  it("renders the server's wording, from and to", () => {
    // Already worded by the server, on purpose: a log that needs today's
    // rendering code to be legible is not an audit trail. This component must
    // not re-derive it.
    setup([
      [
        entry({
          action: "UPDATED",
          changes: [
            { field: "Roll yield", from: "95%", to: "97%" },
            { field: "Plan rows", from: "560 rows", to: "548 rows" },
          ],
        }),
      ],
    ]);

    expect(screen.getByText("Roll yield:")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    expect(screen.getByText("97%")).toBeTruthy();
    expect(screen.getByText("548 rows")).toBeTruthy();
  });

  it("renders nothing for a CREATE, where changes is null", () => {
    // null and [] mean different things — "there is no before" versus "nothing
    // changed" — which is why the component null-checks rather than
    // length-checks.
    const { container } = setup([[entry({ action: "CREATED", changes: null })]]);

    expect(container.querySelectorAll("ul li")).toHaveLength(0);
  });

  it("tolerates an UPDATE that arrived with an empty diff", () => {
    // The server does not write these, but a row edited by hand could produce
    // one. The log is the screen that has to keep rendering when something else
    // has gone wrong.
    setup([[entry({ action: "UPDATED", changes: [] })]]);

    expect(screen.getByText("Updated")).toBeTruthy();
  });
});

describe("paging", () => {
  const full = Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, i) =>
    entry({ id: i + 1, jobLabel: `E${i + 1}` }),
  );

  it("offers Load older when a page came back full", () => {
    setup([full]);

    expect(screen.getByRole("button", { name: /load older/i })).toBeTruthy();
  });

  it("does NOT offer it when a short page proves the end", () => {
    // Returning a cursor from a short page would ask for the same nothing
    // forever, and the button would never go away.
    setup([[entry()]]);

    expect(screen.queryByRole("button", { name: /load older/i })).toBeNull();
  });

  it("shows every loaded page as one list", () => {
    setup([full, [entry({ id: 99, jobLabel: "Older one" })]]);

    expect(screen.getByText("E1")).toBeTruthy();
    expect(screen.getByText("Older one")).toBeTruthy();
  });
});
