import { describe, expect, it } from "vite-plus/test";

import {
  assignColumns,
  formatClockRange,
  formatCompactTime,
  formatHourLabel,
  countByDate,
  formatOccurrenceTime,
  groupByDate,
  layoutDay,
  minutesInZone,
  occursOn,
} from "@/lib/layout-occurrences";

import type { ShiftBlock } from "@/lib/types";

// The suite runs in America/New_York (vite.config.ts). Several assertions here
// read times in Asia/Jakarta and would come out five to twelve hours wrong if
// this module ever reached for the browser's own offset.

let nextId = 1;

function occ(start: string, end: string, overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  return {
    jobId: nextId++,
    occurrenceDate: "2026-09-21",
    shift: 1,
    // Jakarta is UTC+7, so 08:00 local is 01:00Z.
    startsAt: `2026-09-21T${start}:00.000Z`,
    endsAt: `2026-09-21T${end}:00.000Z`,
    timeZone: "Asia/Jakarta",
    lineNames: ["Line 1"],
    lineCount: 1,
    machineCount: 1,
    skuCount: 1,
    ...overrides,
  };
}

// FRIDAY 25 SEPTEMBER'S SHIFT 3, as the server builds it: 23:00 Friday to 07:00
// Saturday in Jakarta, i.e. 16:00Z Friday to 00:00Z Saturday.
function nightShift(overrides: Partial<ShiftBlock> = {}): ShiftBlock {
  return occ("00:00", "00:00", {
    occurrenceDate: "2026-09-25",
    shift: 3,
    startsAt: "2026-09-25T16:00:00.000Z",
    endsAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  });
}

describe("minutesInZone", () => {
  it("reads the clock in the BLOCK's zone, not the machine's", () => {
    // 01:00Z is 08:00 in Jakarta and 21:00 the previous day in New York, which
    // is the zone this suite runs in.
    expect(minutesInZone("2026-09-21T01:00:00.000Z", "Asia/Jakarta")).toBe(8 * 60);
  });

  it("reports midnight as 0, never as 1440", () => {
    // 24:00 would place a block that starts the day at the bottom of it.
    expect(minutesInZone("2026-09-20T17:00:00.000Z", "Asia/Jakarta")).toBe(0);
  });
});

describe("layoutDay — which blocks a day holds", () => {
  it("keeps blocks belonging to other days out", () => {
    const day = layoutDay(
      [occ("01:00", "05:00"), occ("01:00", "05:00", { occurrenceDate: "2026-09-22" })],
      "2026-09-21",
    );
    expect(day.timed).toHaveLength(1);
  });
});

describe("shift 3 crosses midnight — drawn on BOTH days", () => {
  // A third of every job is a night shift. Drawing it only on its business date
  // puts one hour of eight on screen and leaves Saturday morning looking idle.

  it("draws Friday 23:00 – 24:00 in Friday's column", () => {
    const [block] = layoutDay([nightShift()], "2026-09-25").timed;
    expect(block!.topPct).toBeCloseTo((23 / 24) * 100, 5);
    expect(block!.heightPct).toBeCloseTo((1 / 24) * 100, 5);
  });

  it("draws Saturday 00:00 – 07:00 in Saturday's column", () => {
    const [block] = layoutDay([nightShift()], "2026-09-26").timed;
    expect(block!.topPct).toBe(0);
    expect(block!.heightPct).toBeCloseTo((7 / 24) * 100, 5);
    // The SAME block — it is still Friday's shift, on Saturday's clock.
    expect(block!.occurrence.occurrenceDate).toBe("2026-09-25");
  });

  it("does not reach Sunday", () => {
    expect(layoutDay([nightShift()], "2026-09-27").timed).toHaveLength(0);
    expect(layoutDay([nightShift()], "2026-09-24").timed).toHaveLength(0);
  });

  it("treats the end as EXCLUSIVE, so a shift ending at midnight claims one day", () => {
    // 15:00 – 24:00 Jakarta. Without the exclusive end it would also paint a
    // zero-height sliver at the top of the next day.
    const endsAtMidnight = occ("08:00", "17:00", { occurrenceDate: "2026-09-21" });
    expect(occursOn(endsAtMidnight, "2026-09-21")).toBe(true);
    expect(occursOn(endsAtMidnight, "2026-09-22")).toBe(false);
  });

  it("reads the continuation in the BLOCK's zone, not the machine's", () => {
    // 00:00Z Saturday is 20:00 FRIDAY in New York, where this suite runs. A
    // browser-zone reading would decide the shift never reaches Saturday.
    expect(occursOn(nightShift(), "2026-09-26")).toBe(true);
  });
});

describe("layoutDay — geometry", () => {
  it("places 08:00–12:00 Jakarta a third of the way down, four hours tall", () => {
    const [block] = layoutDay([occ("01:00", "05:00")], "2026-09-21").timed;
    expect(block!.topPct).toBeCloseTo((8 / 24) * 100, 5);
    expect(block!.heightPct).toBeCloseTo((4 / 24) * 100, 5);
  });

  it("gives a very short window a readable minimum height", () => {
    // 0.35% of a column is about two pixels with a label in it — a real
    // shift that looks like a rendering artefact.
    const [block] = layoutDay([occ("01:00", "01:05")], "2026-09-21").timed;
    expect(block!.heightPct).toBeGreaterThanOrEqual((15 / 1440) * 100);
  });

  it("never lets a block overflow the bottom of the column", () => {
    const [block] = layoutDay([occ("16:50", "17:00")], "2026-09-21").timed;
    expect(block!.topPct + block!.heightPct).toBeLessThanOrEqual(100.000001);
  });
});

describe("assignColumns — overlap clustering", () => {
  const spans = (items: [number, number][]) =>
    assignColumns(
      items.map(([start, end], i) => ({
        occurrence: { ...occ("01:00", "02:00"), jobId: i + 1 },
        start,
        end,
      })),
    );

  it("gives a lone block the full width", () => {
    const [block] = spans([[480, 720]]);
    expect(block).toMatchObject({ column: 0, columnCount: 1 });
  });

  it("splits two overlapping blocks into two columns", () => {
    const out = spans([
      [480, 720],
      [600, 780],
    ]);
    expect(out.map((b) => b.column)).toEqual([0, 1]);
    expect(out.every((b) => b.columnCount === 2)).toBe(true);
  });

  it("does NOT split blocks that merely touch", () => {
    // 08:00–10:00 and 10:00–12:00 are adjacent, not overlapping. Splitting them
    // would halve the width of every back-to-back job window.
    const out = spans([
      [480, 600],
      [600, 720],
    ]);
    expect(out.every((b) => b.columnCount === 1)).toBe(true);
  });

  it("reuses a column once it is free", () => {
    const out = spans([
      [480, 600],
      [540, 660],
      [610, 700],
    ]);
    // The third starts after the first ended, so it takes column 0 back.
    expect(out.map((b) => b.column)).toEqual([0, 1, 0]);
  });

  it("keeps a later, non-overlapping block FULL WIDTH", () => {
    // The bug this test exists for: computing one width for the whole day makes
    // an isolated afternoon block a third of the width because the morning had
    // a three-way overlap.
    const out = spans([
      [480, 720],
      [540, 780],
      [560, 800],
      [900, 960],
    ]);
    const afternoon = out.find((b) => b.topPct > 50);
    expect(afternoon!.columnCount).toBe(1);
    expect(out.filter((b) => b.topPct < 50).every((b) => b.columnCount === 3)).toBe(true);
  });

  it("emits blocks in clock order", () => {
    // The sweep works cluster by cluster; the DOM must still follow the clock so
    // tab order and screen readers match the page.
    const out = spans([
      [900, 960],
      [480, 720],
      [540, 780],
    ]);
    expect(out.map((b) => b.topPct)).toEqual(out.map((b) => b.topPct).sort((a, b) => a - b));
  });
});

describe("grouping helpers", () => {
  it("counts blocks per BUSINESS date for the month and year grids", () => {
    const counts = countByDate([
      occ("01:00", "02:00"),
      occ("03:00", "04:00"),
      occ("01:00", "02:00", { occurrenceDate: "2026-09-22" }),
    ]);
    expect(counts.get("2026-09-21")).toBe(2);
    expect(counts.get("2026-09-22")).toBe(1);
  });

  it("groups the agenda by date, in order, omitting empty days", () => {
    const groups = groupByDate([
      occ("01:00", "02:00", { occurrenceDate: "2026-09-23" }),
      occ("01:00", "02:00", { occurrenceDate: "2026-09-21" }),
    ]);
    expect(groups.map((g) => g.date)).toEqual(["2026-09-21", "2026-09-23"]);
  });
});

describe("formatCompactTime", () => {
  // What a MONTH CELL shows. The compression is the point: a cell row has one
  // line for a time AND a label, so "07:00 – 15:00 Shift 1 · 3 lines" truncates to
  // the time and the reader never learns the rest.

  it("drops :00 on a whole hour", () => {
    expect(formatCompactTime(occ("01:00", "05:00"))).toBe("8am");
  });

  it("keeps the minutes when there are any", () => {
    // 02:30Z is 09:30 in Jakarta.
    expect(formatCompactTime(occ("02:30", "05:00"))).toBe("9:30am");
  });

  it("zero-pads the minutes but never the hour", () => {
    // 01:05Z -> 08:05 Jakarta. "8:5am" would be wrong; "08:05am" is not the form.
    expect(formatCompactTime(occ("01:05", "05:00"))).toBe("8:05am");
  });

  it("renders the afternoon as pm", () => {
    // 06:15Z -> 13:15 Jakarta.
    expect(formatCompactTime(occ("06:15", "08:00"))).toBe("1:15pm");
  });

  it("renders NOON as 12pm, not 0pm", () => {
    // `hour % 12` alone gives 0 here, which is the classic off-by-twelve.
    // 05:00Z -> 12:00 Jakarta.
    expect(formatCompactTime(occ("05:00", "06:00"))).toBe("12pm");
  });

  it("renders MIDNIGHT as 12am, not 0am", () => {
    // 17:00Z the previous day -> 00:00 Jakarta.
    expect(
      formatCompactTime({ ...occ("01:00", "02:00"), startsAt: "2026-09-20T17:00:00.000Z" }),
    ).toBe("12am");
  });

  it("reads the clock in the BLOCK's zone, not the machine's", () => {
    // The suite runs in America/New_York, where this instant is the previous
    // evening. The plan is in Jakarta and must say so.
    expect(formatCompactTime(occ("01:00", "05:00"))).toBe("8am");
  });
});

describe("labels", () => {
  it("renders a block's range in the block's zone, in ONE clock vocabulary", () => {
    // Matches the hour gutter and the month rows. A block reading "08:00 – 12:00"
    // beside a gutter reading "8am" makes the reader translate to line them up.
    expect(formatOccurrenceTime(occ("01:00", "05:00"))).toBe("8am – 12pm");
  });

  it("keeps a 24-hour range available for anywhere that wants exactness", () => {
    expect(formatClockRange(occ("01:00", "05:00"))).toBe("08:00 – 12:00");
  });

  it("labels the hour gutter in that same vocabulary", () => {
    expect(formatHourLabel(0)).toBe("12am");
    expect(formatHourLabel(8)).toBe("8am");
    expect(formatHourLabel(12)).toBe("12pm");
    expect(formatHourLabel(23)).toBe("11pm");
  });

  it("labels shift 3 by its wall clock, ending on the next morning", () => {
    expect(formatClockRange(nightShift())).toBe("23:00 – 07:00");
  });
});
