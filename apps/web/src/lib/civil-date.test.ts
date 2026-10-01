import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInMonth,
  diffDays,
  isCivilDate,
  formatCivilLong,
  formatCivilRange,
  toDayMonthYear,
  startOfMonth,
  startOfWeek,
  startOfYear,
  todayIn,
} from "@/lib/civil-date";

// These tests run under whatever TZ the suite sets (CI pins a DST zone — see
// vite.config.ts). That is the point: every assertion here must hold in every
// zone, because a civil date is not a time.

describe("isCivilDate", () => {
  it("accepts a real date", () => {
    expect(isCivilDate("2026-09-21")).toBe(true);
  });

  it("rejects a date the calendar does not have", () => {
    // The regex alone would pass this; only the round trip catches it.
    expect(isCivilDate("2026-02-30")).toBe(false);
    expect(isCivilDate("2026-13-01")).toBe(false);
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(isCivilDate("2026-9-21")).toBe(false);
    expect(isCivilDate("21/09/2026")).toBe(false);
    expect(isCivilDate("2026-09-21T00:00:00Z")).toBe(false);
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(isCivilDate("2028-02-29")).toBe(true);
    expect(isCivilDate("2027-02-29")).toBe(false);
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });

  it("crosses a year boundary in both directions", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("crosses a leap day", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("is exact across a DST transition in the machine's zone", () => {
    // The US spring-forward is 2026-03-08. A local-time implementation adding
    // 24h here lands on the 8th twice or skips it; UTC midnight cannot.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    // ...and the autumn fall-back, 2026-11-01.
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("diffDays", () => {
  it("counts whole days, signed", () => {
    expect(diffDays("2026-09-21", "2026-09-28")).toBe(7);
    expect(diffDays("2026-09-28", "2026-09-21")).toBe(-7);
    expect(diffDays("2026-09-21", "2026-09-21")).toBe(0);
  });

  it("counts a DST week as seven days, not 6.96", () => {
    expect(diffDays("2026-03-07", "2026-03-14")).toBe(7);
    expect(diffDays("2026-10-31", "2026-11-07")).toBe(7);
  });

  it("counts a leap year as 366 days", () => {
    expect(diffDays("2028-01-01", "2029-01-01")).toBe(366);
    expect(diffDays("2026-01-01", "2027-01-01")).toBe(365);
  });
});

describe("dayOfWeek", () => {
  it("reads the civil weekday, Sunday = 0", () => {
    expect(dayOfWeek("2026-09-20")).toBe(0);
    expect(dayOfWeek("2026-09-21")).toBe(1);
    expect(dayOfWeek("2026-09-26")).toBe(6);
  });
});

describe("startOfWeek", () => {
  it("snaps back to Sunday by default", () => {
    expect(startOfWeek("2026-09-23")).toBe("2026-09-20");
  });

  it("returns the date itself when it already is the start", () => {
    expect(startOfWeek("2026-09-20")).toBe("2026-09-20");
  });

  it("honours a Monday start", () => {
    expect(startOfWeek("2026-09-23", 1)).toBe("2026-09-21");
    // A Sunday with a Monday start belongs to the week that BEGAN six days ago,
    // not to the one starting tomorrow.
    expect(startOfWeek("2026-09-20", 1)).toBe("2026-09-14");
  });
});

describe("addMonths", () => {
  it("clamps rather than rolling over", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("crosses a year boundary", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-01-01", 12)).toBe("2027-01-01");
  });
});

describe("startOfMonth / startOfYear / daysInMonth", () => {
  it("snaps to the first", () => {
    expect(startOfMonth("2026-09-21")).toBe("2026-09-01");
    expect(startOfYear("2026-09-21")).toBe("2026-01-01");
  });

  it("knows February in both kinds of year", () => {
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2028-02-10")).toBe(29);
    expect(daysInMonth("2026-09-01")).toBe(30);
    expect(daysInMonth("2026-12-01")).toBe(31);
  });
});

describe("todayIn", () => {
  it("answers the plant's date, not the machine's", () => {
    // Two zones far enough apart that at some instant every day they disagree.
    // The assertion is only that both are well-formed and at most a day apart —
    // asserting a literal would make this test a clock.
    const jakarta = todayIn("Asia/Jakarta");
    const honolulu = todayIn("Pacific/Honolulu");
    expect(isCivilDate(jakarta)).toBe(true);
    expect(isCivilDate(honolulu)).toBe(true);
    expect(Math.abs(diffDays(honolulu, jakarta))).toBeLessThanOrEqual(1);
  });
});

describe("the long form", () => {
  it("prints weekday, day, month and year from the CIVIL fields", () => {
    // The suite runs in New York. A formatter fed `new Date("2026-09-23")` would
    // print Tuesday the 22nd here — midnight UTC is the previous evening.
    expect(formatCivilLong("2026-09-23")).toBe("Wed, 23 Sep 2026");
  });

  it("collapses a one-day range to a single date", () => {
    expect(formatCivilRange("2026-09-25", "2026-09-25")).toBe("Fri, 25 Sep 2026");
    expect(formatCivilRange("2026-09-23", "2026-09-25")).toBe(
      "Wed, 23 Sep 2026 – Fri, 25 Sep 2026",
    );
  });

  it("writes the CSV's DD/MM/YYYY", () => {
    expect(toDayMonthYear("2026-09-05")).toBe("05/09/2026");
  });
});
