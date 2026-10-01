import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_TAB,
  DEFAULT_VIEW,
  mergeSearch,
  validateCalendarSearch,
} from "@/lib/calendar-search";

// THE URL IS THE SOURCE OF TRUTH for the whole schedule, and this is the only
// thing standing between a hand-edited link and the screen. Every case below is
// a URL somebody could actually produce — by sharing, by editing, or by a bug
// elsewhere writing a stale value.
//
// The governing rule: a malformed parameter is DROPPED, never an error. Opening
// a shared link should land on the default schedule, not an error boundary.

describe("tab", () => {
  it("keeps a tab it recognises", () => {
    expect(validateCalendarSearch({ tab: "gantt" }).tab).toBe("gantt");
    expect(validateCalendarSearch({ tab: "table" }).tab).toBe("table");
  });

  it("drops one it does not, and the default is the CALENDAR", () => {
    expect(validateCalendarSearch({ tab: "kanban" }).tab).toBeUndefined();
    expect(validateCalendarSearch({}).tab).toBeUndefined();
    // Undefined means "use the default", applied when the value is READ — so
    // `/calendar` with no parameters is still the Calendar tab.
    expect(DEFAULT_TAB).toBe("calendar");
  });
});

describe("view", () => {
  it("keeps a view it recognises", () => {
    expect(validateCalendarSearch({ view: "month" }).view).toBe("month");
  });

  it("drops one it does not, falling back to the default", () => {
    expect(validateCalendarSearch({ view: "hour" }).view).toBeUndefined();
    expect(DEFAULT_VIEW).toBe("fourDay");
  });
});

describe("date", () => {
  it("keeps a real calendar date", () => {
    expect(validateCalendarSearch({ date: "2026-09-21" }).date).toBe("2026-09-21");
  });

  it("drops a date the calendar does not have", () => {
    // Passing this through would let `new Date()` silently move it to 2 March.
    expect(validateCalendarSearch({ date: "2026-02-30" }).date).toBeUndefined();
  });

  it("drops anything that is not YYYY-MM-DD", () => {
    expect(validateCalendarSearch({ date: "21/09/2026" }).date).toBeUndefined();
    expect(validateCalendarSearch({ date: "2026-09-21T00:00:00Z" }).date).toBeUndefined();
  });
});

describe("from / to", () => {
  it("keeps a real range", () => {
    expect(validateCalendarSearch({ from: "2026-09-23", to: "2026-09-25" })).toMatchObject({
      from: "2026-09-23",
      to: "2026-09-25",
    });
  });

  it("keeps a one-day range", () => {
    expect(validateCalendarSearch({ from: "2026-09-23", to: "2026-09-23" }).to).toBe("2026-09-23");
  });

  it("drops a `to` BEFORE `from` rather than guessing which end was the typo", () => {
    const s = validateCalendarSearch({ from: "2026-09-25", to: "2026-09-23" });
    expect(s.from).toBe("2026-09-25");
    expect(s.to).toBeUndefined();
  });

  it("drops a `to` with no `from`", () => {
    expect(validateCalendarSearch({ to: "2026-09-25" }).to).toBeUndefined();
  });

  it("drops an unreal date", () => {
    expect(validateCalendarSearch({ from: "2026-02-31" }).from).toBeUndefined();
  });
});

describe("lines and machines", () => {
  it("reads the router's own ARRAY encoding", () => {
    expect(validateCalendarSearch({ lines: [1, 2], machines: [10] })).toMatchObject({
      lines: [1, 2],
      machines: [10],
    });
  });

  it("reads a hand-typed comma list", () => {
    expect(validateCalendarSearch({ lines: "1,2", machines: "10,11" })).toMatchObject({
      lines: [1, 2],
      machines: [10, 11],
    });
  });

  it("drops junk entries one by one and de-duplicates", () => {
    expect(validateCalendarSearch({ lines: ["3", "x", 0, -1, 1.5, "3", 4] }).lines).toEqual([3, 4]);
  });

  it("treats an empty list as ABSENT, so 'no filter' has one spelling", () => {
    expect(validateCalendarSearch({ lines: [] }).lines).toBeUndefined();
    expect(validateCalendarSearch({ lines: "" }).lines).toBeUndefined();
  });

  it("DROPS machines that arrive without a line", () => {
    // The machine picker IS the selected lines' roster, so a machine with no
    // line filters the page to nothing while showing a control with no line.
    expect(validateCalendarSearch({ machines: [100] }).machines).toBeUndefined();
  });
});

describe("page and size", () => {
  it("keeps positive integers", () => {
    expect(validateCalendarSearch({ page: "3", size: "25" })).toMatchObject({ page: 3, size: 25 });
  });

  it("drops a size above the api's cap of 100", () => {
    expect(validateCalendarSearch({ size: 500 }).size).toBeUndefined();
  });

  it("drops zero and negative pages", () => {
    expect(validateCalendarSearch({ page: 0 }).page).toBeUndefined();
    expect(validateCalendarSearch({ page: -2 }).page).toBeUndefined();
  });
});

describe("the whole object", () => {
  it("survives a URL of pure junk", () => {
    expect(
      validateCalendarSearch({
        tab: 1,
        view: {},
        date: 7,
        from: [],
        to: null,
        lines: {},
        machines: null,
        page: "x",
        size: {},
      }),
    ).toEqual({
      tab: undefined,
      view: undefined,
      date: undefined,
      from: undefined,
      to: undefined,
      lines: undefined,
      machines: undefined,
      page: undefined,
      size: undefined,
    });
  });

  it("no longer carries the recurring or search parameters", () => {
    // Recurrence was removed and a job has no name to search; a stale link that
    // still carries them must not resurrect a filter nothing on screen shows.
    const s = validateCalendarSearch({ recurring: "false", q: "pump" }) as Record<string, unknown>;
    expect(s.recurring).toBeUndefined();
    expect(s.q).toBeUndefined();
  });
});

describe("mergeSearch — what a write does beyond merging", () => {
  it("resets the page on any change that is not a page change", () => {
    // Page 7 of a newly filtered list is usually past its end, and an empty
    // page reads as "the filter matched nothing".
    expect(mergeSearch({ page: 7 }, { lines: [1] }).page).toBeUndefined();
    expect(mergeSearch({ page: 7 }, { size: 50 }).page).toBeUndefined();
  });

  it("keeps the page when the page is what changed", () => {
    expect(mergeSearch({ page: 2 }, { page: 3 }).page).toBe(3);
  });

  it("clears the machines in the SAME write that clears the lines", () => {
    const out = mergeSearch({ lines: [1], machines: [10] }, { lines: [] });
    expect(out.lines).toBeUndefined();
    expect(out.machines).toBeUndefined();
  });

  it("writes an empty machine list as absent", () => {
    expect(mergeSearch({ lines: [1], machines: [10] }, { machines: [] }).machines).toBeUndefined();
  });

  it("drops the calendar's paged anchor when a new range is picked", () => {
    // Otherwise the calendar stays on whatever week it was paged to while the
    // sidebar shows a different range, and the two disagree about "now".
    const out = mergeSearch({ date: "2026-12-01" }, { from: "2026-09-23", to: "2026-09-25" });
    expect(out.date).toBeUndefined();
    expect(out.from).toBe("2026-09-23");
  });

  it("leaves the range alone when the calendar pages", () => {
    const out = mergeSearch({ from: "2026-09-23", to: "2026-09-25" }, { date: "2026-09-27" });
    expect(out).toMatchObject({ from: "2026-09-23", to: "2026-09-25", date: "2026-09-27" });
  });
});
