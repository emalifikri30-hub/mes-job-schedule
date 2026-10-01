import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PLAN_ROWS,
  PLAN_HEADER,
  buildPlanTemplate,
  fromDayMonthYear,
  parsePlanCsv,
  planToCsv,
  planToRawRows,
} from "@/lib/job-plan-csv";

import type { PlanRow } from "@/lib/types";

// THE PLAN CSV, SYNTAX ONLY. Master-data questions (does this line exist, is the
// machine on it) are the server's and are tested there; what is tested here is
// everything a spreadsheet can get wrong on its own, and that the row numbers
// every error carries point at the right line.

const HEADER = PLAN_HEADER.join(";");

function file(...rows: string[]): string {
  return [HEADER, ...rows].join("\r\n");
}

const GOOD = "25/09/2026;Line 1;SKU A;SKU-A;200;Machine 1.1;v;;V";

describe("the template", () => {
  const csv = buildPlanTemplate(
    ["2026-09-25", "2026-09-26"],
    [
      {
        name: "Line 1",
        machines: [{ name: "Machine 1.1" }, { name: "Machine 1.2" }],
        products: [{ code: "SKU-A", name: "SKU A" }],
      },
    ],
  );

  it("starts with a BOM, so Excel reads it as UTF-8", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("carries the header EXACTLY", () => {
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "date;line;sku;sku_code;target;machine;shift1;shift2;shift3",
    );
  });

  it("lists every date x machine x SKU, target 0, all shifts ticked", () => {
    const lines = csv.slice(1).split("\r\n").slice(1);
    expect(lines).toEqual([
      "25/09/2026;Line 1;SKU A;SKU-A;0;Machine 1.1;v;v;v",
      "25/09/2026;Line 1;SKU A;SKU-A;0;Machine 1.2;v;v;v",
      "26/09/2026;Line 1;SKU A;SKU-A;0;Machine 1.1;v;v;v",
      "26/09/2026;Line 1;SKU A;SKU-A;0;Machine 1.2;v;v;v",
    ]);
  });

  it("reads back without a single error", () => {
    const parsed = parsePlanCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(4);
  });
});

describe("the saved plan, exported and re-read", () => {
  const plan: PlanRow[] = [
    {
      planDate: "2026-09-26",
      workCenterId: 1,
      workCenterName: "Line 1",
      workUnitId: 11,
      workUnitName: "Machine 1.1",
      productId: 100,
      productCode: "SKU-A",
      productName: "SKU A; 1 kg",
      target: 150,
      uomCode: "CTN",
      uomName: "Carton",
      shift1: true,
      shift2: false,
      shift3: true,
    },
  ];

  it("leaves an unticked shift BLANK and quotes a name holding the delimiter", () => {
    const line = planToCsv(plan).slice(1).split("\r\n")[1];
    expect(line).toBe('26/09/2026;Line 1;"SKU A; 1 kg";SKU-A;150;Machine 1.1;v;;v');
  });

  it("round-trips to the same raw rows an unchanged re-save would send", () => {
    // Otherwise "Download current plan, re-upload it" would change the plan.
    expect(parsePlanCsv(planToCsv(plan)).rows).toEqual(planToRawRows(plan));
  });
});

describe("dates", () => {
  it("converts DD/MM/YYYY to YYYY-MM-DD", () => {
    expect(fromDayMonthYear("05/10/2026")).toBe("2026-10-05");
  });

  it("REJECTS a date the calendar does not have", () => {
    // `new Date` would quietly roll 31/02 into March.
    expect(fromDayMonthYear("31/02/2026")).toBeUndefined();
    expect(fromDayMonthYear("29/02/2027")).toBeUndefined();
    expect(fromDayMonthYear("29/02/2028")).toBe("2028-02-29");
  });

  it("rejects other shapes rather than guessing the order", () => {
    expect(fromDayMonthYear("2026-10-05")).toBeUndefined();
    expect(fromDayMonthYear("5/10/2026")).toBeUndefined();
  });

  it("reports a bad date against its row", () => {
    const { errors } = parsePlanCsv(file(GOOD, "31/02/2026;Line 1;SKU A;SKU-A;1;M;v;;"));
    expect(errors).toEqual([expect.objectContaining({ row: 2, field: "date" })]);
  });
});

describe("a good row", () => {
  it("parses every cell, with `v` in either case as ticked", () => {
    expect(parsePlanCsv(file(GOOD))).toEqual({
      errors: [],
      rows: [
        {
          row: 1,
          date: "2026-09-25",
          line: "Line 1",
          sku: "SKU A",
          skuCode: "SKU-A",
          target: 200,
          machine: "Machine 1.1",
          shift1: true,
          shift2: false,
          shift3: true,
        },
      ],
    });
  });

  it("keeps a row with NO shift ticked — the server skips it, it is not an error", () => {
    // That is how a planner says "not this SKU here today" in a template that
    // lists every pair.
    const { rows, errors } = parsePlanCsv(file("25/09/2026;Line 1;SKU A;SKU-A;0;M;;;"));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe("shift cells", () => {
  it("rejects anything but `v` or blank", () => {
    const { errors } = parsePlanCsv(file("25/09/2026;Line 1;SKU A;SKU-A;0;M;x;yes;1"));
    expect(errors.map((e) => e.field)).toEqual(["shift1", "shift2", "shift3"]);
  });
});

describe("targets", () => {
  const withTarget = (t: string) => parsePlanCsv(file(`25/09/2026;L;S;C;${t};M;v;;`));

  it("accepts a whole number and a decimal with either mark", () => {
    expect(withTarget("400").rows[0]!.target).toBe(400);
    expect(withTarget("1.5").rows[0]!.target).toBe(1.5);
    // Indonesian-locale Excel writes one and a half with a comma.
    expect(withTarget("1,5").rows[0]!.target).toBe(1.5);
    expect(withTarget("0.125").rows[0]!.target).toBe(0.125);
  });

  it("REFUSES a thousands-shaped number rather than guess a factor of 1000", () => {
    expect(withTarget("1.000").errors[0]).toMatchObject({ field: "target" });
    expect(withTarget("2,500").errors[0]!.message).toMatch(/ambiguous/);
  });

  it("refuses a negative, a blank and text", () => {
    expect(withTarget("-5").errors[0]).toMatchObject({ field: "target" });
    expect(withTarget("").errors[0]).toMatchObject({ field: "target" });
    expect(withTarget("lots").errors[0]).toMatchObject({ field: "target" });
  });
});

describe("the file as a whole — row 0", () => {
  it("refuses an empty file", () => {
    expect(parsePlanCsv("").errors).toEqual([expect.objectContaining({ row: 0 })]);
    expect(parsePlanCsv("﻿\r\n\r\n").errors[0]!.message).toMatch(/empty/);
  });

  it("refuses a header with no rows", () => {
    expect(parsePlanCsv(HEADER).errors[0]!.message).toMatch(/no plan rows/);
  });

  it("names the COMMA problem specifically, since it is the likeliest one", () => {
    // A sheet re-saved from an English-locale Excel comes back comma-separated
    // and reads as ONE column; "bad header" would not say what to do.
    const commaFile = [PLAN_HEADER.join(","), GOOD.replaceAll(";", ",")].join("\n");
    expect(parsePlanCsv(commaFile).errors[0]!.message).toMatch(/separated by commas/);
  });

  it("refuses a header that is not the template's", () => {
    const { errors } = parsePlanCsv("date;line;sku;target;machine;shift1;shift2;shift3\n" + GOOD);
    expect(errors[0]!.message).toMatch(/header/);
  });

  it("accepts a header in any case, from a spreadsheet that capitalised it", () => {
    expect(parsePlanCsv([HEADER.toUpperCase(), GOOD].join("\n")).errors).toEqual([]);
  });

  it(`refuses more than ${MAX_PLAN_ROWS} rows before sending them`, () => {
    const many = Array.from({ length: MAX_PLAN_ROWS + 1 }, () => GOOD);
    expect(parsePlanCsv(file(...many)).errors[0]).toMatchObject({ row: 0 });
    expect(parsePlanCsv(file(...many.slice(1))).errors).toEqual([]);
  });
});

describe("row numbers", () => {
  it("count DATA rows from 1, header excluded", () => {
    const { errors } = parsePlanCsv(file(GOOD, GOOD, "bad;row"));
    expect(errors[0]).toMatchObject({ row: 3, field: "row" });
  });

  it("COUNT a blank row, so an error still points at the right spreadsheet line", () => {
    // Skipping blanks while counting would send the planner to row 2 to fix
    // what is on row 3.
    const { rows, errors } = parsePlanCsv(file(GOOD, "", "25/09/2026;L;S;C;x;M;v;;"));
    expect(rows).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 3, field: "target" });
  });

  it("collect EVERY error, not just the first, so one upload fixes them all", () => {
    const { errors } = parsePlanCsv(file("xx;;S;;1;;v;;", GOOD, "25/09/2026;L;S;C;1;M;q;;"));
    expect(errors.map((e) => `${e.row}:${e.field}`)).toEqual([
      "1:date",
      "1:line",
      "1:machine",
      "1:skuCode",
      "3:shift1",
    ]);
  });
});
