import { describe, expect, it } from "vite-plus/test";

import { nextCivilDate, shiftInstants } from "./shift.js";

// Runs under TZ=America/New_York (vite.config.ts). Every expectation below is
// a UTC instant, so a helper that leaked the PROCESS zone into the arithmetic
// would be off by the New York offset and fail here rather than in a plant.

describe("shiftInstants", () => {
  it("places shift 1 at 07:00-15:00 on the business date, in the plant's zone", () => {
    const { startsAt, endsAt } = shiftInstants("2026-09-25", 1, "Asia/Jakarta");
    // Jakarta is UTC+7.
    expect(startsAt.toISOString()).toBe("2026-09-25T00:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-09-25T08:00:00.000Z");
  });

  it("places shift 2 at 15:00-23:00", () => {
    const { startsAt, endsAt } = shiftInstants("2026-09-25", 2, "Asia/Jakarta");
    expect(startsAt.toISOString()).toBe("2026-09-25T08:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-09-25T16:00:00.000Z");
  });

  it("runs shift 3 from 23:00 on the business date to 07:00 the NEXT day", () => {
    const { startsAt, endsAt } = shiftInstants("2026-09-25", 3, "Asia/Jakarta");
    expect(startsAt.toISOString()).toBe("2026-09-25T16:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-09-26T00:00:00.000Z");
    expect(endsAt.getTime() - startsAt.getTime()).toBe(8 * 3_600_000);
  });

  it("crosses a month and a year boundary for shift 3", () => {
    const { endsAt } = shiftInstants("2026-12-31", 3, "Asia/Makassar");
    // WITA is UTC+8: 07:00 on 1 Jan is 23:00 UTC on 31 Dec.
    expect(endsAt.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });

  // The DST case the suite's zone exists for: a plant in a zone that DOES
  // observe it. The night shift that spans the spring-forward gap is 7 hours
  // long in real time, not 8 — wall-clock 23:00 to 07:00 is what was planned.
  it("keeps wall-clock boundaries across a DST transition", () => {
    const { startsAt, endsAt } = shiftInstants("2026-03-07", 3, "America/New_York");
    expect(startsAt.toISOString()).toBe("2026-03-08T04:00:00.000Z");
    expect(endsAt.toISOString()).toBe("2026-03-08T11:00:00.000Z");
  });
});

describe("nextCivilDate", () => {
  it("steps over month ends and leap days", () => {
    expect(nextCivilDate("2026-02-28")).toBe("2026-03-01");
    expect(nextCivilDate("2028-02-28")).toBe("2028-02-29");
    expect(nextCivilDate("2026-12-31")).toBe("2027-01-01");
  });
});
