import { isCivilDate, toDayMonthYear } from "@/lib/civil-date";
import { parseCsv, toCsv } from "@/lib/csv";

import type { PlanIssue, PlanRow, RawPlanRow } from "@/lib/types";

// THE PLAN CSV — building the template, exporting a saved plan, and reading an
// upload back. SYNTAX ONLY (decision 6A).
//
//   date;line;sku;sku_code;target;machine;shift1;shift2;shift3
//   25/09/2026;Line 1;SKU A;SKU-A;0;Machine 1.1;v;v;v
//
// WHAT THIS FILE CHECKS, AND WHAT IT LEAVES TO THE SERVER
//
// It checks what a spreadsheet can get wrong on its own: the header, the column
// count, a date that is a date, a number that is a number, a shift cell that is
// `v` or blank. It does NOT check that "Line 1" exists, that "Machine 1.1" is on
// it, or that SKU-A is made there — that needs master data, and a browser is
// not a source of truth about master data. POST /jobs/preview answers those
// with the same row numbers, through the same `resolve()` the save runs, so
// preview and save cannot disagree about what a row means.
//
// ROW NUMBERS ARE DATA ROWS, 1-BASED, HEADER EXCLUDED, and they COUNT blank
// rows — which is why the reader is asked to keep them (lib/csv.ts). The
// planner fixing "row 12" is looking at spreadsheet row 13, under a header;
// skipping blanks while counting would send them somewhere else.

const PLAN_HEADER = [
  "date",
  "line",
  "sku",
  "sku_code",
  "target",
  "machine",
  "shift1",
  "shift2",
  "shift3",
] as const;

const DELIMITER = ";";

// The server's own cap (decision 18A). Checked here too so a 40,000-row export
// is refused before it is sent, rather than uploaded and then refused.
const MAX_PLAN_ROWS = 5000;

const TICK = "v";

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type TemplateLine = {
  name: string;
  machines: { name: string }[];
  products: { code: string; name: string }[];
};

// The empty plan a planner fills in: every date x every machine on each chosen
// line x every SKU of that line, target 0, all three shifts ticked.
//
// EVERY PAIR, ALL TICKED, rather than a blank sheet, because deleting is easier
// than typing: a planner clears the shifts a SKU does not run on (a row with
// none ticked is skipped, not an error) instead of retyping machine names and
// SKU codes the server would then have to match character for character.
function buildPlanTemplate(dates: string[], lines: TemplateLine[]): string {
  const rows: string[][] = [[...PLAN_HEADER]];
  for (const date of dates) {
    for (const line of lines) {
      for (const machine of line.machines) {
        for (const product of line.products) {
          rows.push([
            toDayMonthYear(date),
            line.name,
            product.name,
            product.code,
            "0",
            machine.name,
            TICK,
            TICK,
            TICK,
          ]);
        }
      }
    }
  }
  return toCsv(rows, { delimiter: DELIMITER, bom: true });
}

// ONE ORDER for a saved plan, shared by the export and the raw rows, so row 12
// of the downloaded file is row 12 of what an unchanged re-save sends — and an
// issue the server reports against it points at the same line either way.
function sortPlan(plan: PlanRow[]): PlanRow[] {
  return [...plan].sort(
    (a, b) =>
      a.planDate.localeCompare(b.planDate) ||
      a.workCenterName.localeCompare(b.workCenterName) ||
      a.workUnitName.localeCompare(b.workUnitName) ||
      a.productCode.localeCompare(b.productCode),
  );
}

// A SAVED plan, in the template's own format — "Download current plan" in edit
// mode. Re-uploading it unchanged must reproduce the same plan, so it writes the
// NAMES and CODES the rows were frozen with and leaves unticked shifts blank.
function planToCsv(plan: PlanRow[]): string {
  const rows: string[][] = [[...PLAN_HEADER]];
  const sorted = sortPlan(plan);
  for (const row of sorted) {
    rows.push([
      toDayMonthYear(row.planDate),
      row.workCenterName,
      row.productName,
      row.productCode,
      String(row.target),
      row.workUnitName,
      row.shift1 ? TICK : "",
      row.shift2 ? TICK : "",
      row.shift3 ? TICK : "",
    ]);
  }
  return toCsv(rows, { delimiter: DELIMITER, bom: true });
}

// The saved plan as the RAW rows the api takes, so an edit that changes only the
// header can be saved without re-uploading anything. Numbered in sortPlan's
// order, for the reason stated there.
function planToRawRows(plan: PlanRow[]): RawPlanRow[] {
  const sorted = sortPlan(plan);
  return sorted.map((row, index) => ({
    row: index + 1,
    date: row.planDate,
    line: row.workCenterName,
    sku: row.productName,
    skuCode: row.productCode,
    target: row.target,
    machine: row.workUnitName,
    shift1: row.shift1,
    shift2: row.shift2,
    shift3: row.shift3,
  }));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type ParsedPlan = {
  rows: RawPlanRow[];
  // Row 0 is the file as a whole. When there are any, `rows` must not be sent —
  // a preview of half a file would show a confirmation of a plan nobody wrote.
  errors: PlanIssue[];
};

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

// DD/MM/YYYY -> YYYY-MM-DD, or undefined for anything that is not a real date.
// `isCivilDate` is what rejects 31/02 — the shape is fine and `new Date` would
// quietly roll it into March.
function fromDayMonthYear(value: string): string | undefined {
  const match = DATE_RE.exec(value);
  if (match === null) return undefined;
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  return isCivilDate(iso) ? iso : undefined;
}

// A target: a non-negative number, with `.` OR `,` as the decimal mark.
//
// The comma is accepted because the template is opened in an Indonesian-locale
// Excel, which writes one and a half as "1,5". What is REFUSED is a separator
// followed by exactly three digits — "1.000", "2,500" — because in that locale
// it is the THOUSANDS separator and in every other it is a decimal, and the two
// readings differ by a factor of a thousand. Refusing costs the planner one
// retype; guessing costs a plan a thousand times too small. (A leading zero is
// never a thousands group, so "0.125" is read as the decimal it must be.)
function parseTarget(value: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = value.trim();
  if (text === "") return { ok: false, message: "target is empty" };
  if (/^[1-9]\d{0,2}([.,]\d{3})+$/.test(text)) {
    return {
      ok: false,
      message: `"${text}" is ambiguous — write the number without a thousands separator`,
    };
  }
  if (!/^\d+([.,]\d+)?$/.test(text)) {
    return { ok: false, message: `"${text}" is not a number of zero or more` };
  }
  return { ok: true, value: Number(text.replace(",", ".")) };
}

function parseShift(value: string): boolean | undefined {
  const text = value.trim();
  if (text === "") return false;
  if (text.toLowerCase() === TICK) return true;
  return undefined;
}

function parsePlanCsv(text: string): ParsedPlan {
  const fileError = (message: string): ParsedPlan => ({
    rows: [],
    errors: [{ row: 0, field: "file", message }],
  });

  const records = parseCsv(text, { delimiter: DELIMITER, keepBlank: true });
  // Blank lines BEFORE the header are an artefact too; the header is the first
  // record with anything in it.
  while (records.length > 0 && records[0]!.every((cell) => cell.trim() === "")) records.shift();
  if (records.length === 0) return fileError("The file is empty.");

  const header = records[0]!.map((cell) => cell.trim().toLowerCase());

  // THE WRONG DELIMITER gets its own message, because it is the single most
  // likely thing to go wrong and the generic "bad header" would not say what to
  // do: a sheet re-saved from an English-locale Excel comes back
  // comma-separated, and reads here as ONE column holding the whole header.
  if (header.length === 1 && header[0]!.split(",").length === PLAN_HEADER.length) {
    return fileError(
      "This file is separated by commas. The template uses semicolons (;) — save it as CSV with a semicolon separator, or download the template again.",
    );
  }
  if (header.length !== PLAN_HEADER.length || header.some((cell, i) => cell !== PLAN_HEADER[i])) {
    return fileError(`The first row must be the header: ${PLAN_HEADER.join(DELIMITER)}`);
  }

  const data = records.slice(1);
  const nonBlank = data.filter((r) => r.some((cell) => cell.trim() !== "")).length;
  if (nonBlank === 0) return fileError("The file has a header but no plan rows.");
  if (nonBlank > MAX_PLAN_ROWS) {
    return fileError(
      `The file has ${nonBlank} plan rows; a job can hold at most ${MAX_PLAN_ROWS}. Split it into shorter jobs.`,
    );
  }

  const rows: RawPlanRow[] = [];
  const errors: PlanIssue[] = [];

  data.forEach((cells, index) => {
    const row = index + 1;
    // A blank row is skipped but still COUNTED — see the header note.
    if (cells.every((cell) => cell.trim() === "")) return;

    if (cells.length !== PLAN_HEADER.length) {
      errors.push({
        row,
        field: "row",
        message: `has ${cells.length} columns; the template has ${PLAN_HEADER.length}`,
      });
      return;
    }

    const [dateCell, line, sku, skuCode, targetCell, machine, s1, s2, s3] = cells.map((c) =>
      c.trim(),
    ) as [string, string, string, string, string, string, string, string, string];
    const before = errors.length;

    const date = fromDayMonthYear(dateCell);
    if (date === undefined) {
      errors.push({ row, field: "date", message: `"${dateCell}" is not a date (DD/MM/YYYY)` });
    }
    if (line === "") errors.push({ row, field: "line", message: "line is empty" });
    if (machine === "") errors.push({ row, field: "machine", message: "machine is empty" });
    if (skuCode === "") errors.push({ row, field: "skuCode", message: "sku_code is empty" });

    const target = parseTarget(targetCell);
    if (!target.ok) errors.push({ row, field: "target", message: target.message });

    const shifts = [s1, s2, s3].map(parseShift);
    shifts.forEach((value, i) => {
      if (value === undefined) {
        errors.push({
          row,
          field: `shift${i + 1}`,
          message: `"${[s1, s2, s3][i]}" — a shift cell is "v" or blank`,
        });
      }
    });

    if (errors.length > before || date === undefined || !target.ok) return;
    rows.push({
      row,
      date,
      line,
      sku,
      skuCode,
      target: target.value,
      machine,
      shift1: shifts[0]!,
      shift2: shifts[1]!,
      shift3: shifts[2]!,
    });
  });

  return { rows, errors };
}

export {
  MAX_PLAN_ROWS,
  PLAN_HEADER,
  buildPlanTemplate,
  fromDayMonthYear,
  parsePlanCsv,
  planToCsv,
  planToRawRows,
};
export type { ParsedPlan, TemplateLine };
