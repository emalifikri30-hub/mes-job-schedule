import { describe, it, expect } from "vite-plus/test";

import { parseCsv, toCsv } from "@/lib/csv";

// Copied from mes-master-data with the reader's original cases intact, plus the
// three extensions the plan template needs: a `;` delimiter, a BOM on write,
// and blank records kept when row numbers matter.

describe("parseCsv", () => {
  it("reads a plain table", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas and newlines inside quoted fields", () => {
    expect(parseCsv('a,b\n"x,y","line1\nline2"')).toEqual([
      ["a", "b"],
      ["x,y", "line1\nline2"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("handles CRLF and the BOM Excel writes", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops blank lines rather than reading them as rows", () => {
    expect(parseCsv("a,b\n\n1,2\n,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("round-trips fields that need quoting", () => {
    const rows = [
      ["Source Tag", "Note"],
      ['PLC/"A",1', "two\nlines"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("the `;` delimiter", () => {
  it("splits on `;` and leaves commas alone", () => {
    // A decimal comma is ordinary text in a `;` file — the reason the template
    // uses `;` at all.
    expect(parseCsv("a;b\n1,5;2", { delimiter: ";" })).toEqual([
      ["a", "b"],
      ["1,5", "2"],
    ]);
  });

  it("keeps a `;` inside a quoted field", () => {
    expect(parseCsv('a;b\n"x;y";z', { delimiter: ";" })).toEqual([
      ["a", "b"],
      ["x;y", "z"],
    ]);
  });

  it("quotes a cell carrying the delimiter, and ONLY that delimiter", () => {
    expect(toCsv([["x;y", "a,b"]], { delimiter: ";" })).toBe('"x;y";a,b');
  });

  it("round-trips through `;`", () => {
    const rows = [
      ["date", "sku"],
      ["25/09/2026", 'Saus "Pedas"; 1 kg'],
    ];
    expect(parseCsv(toCsv(rows, { delimiter: ";" }), { delimiter: ";" })).toEqual(rows);
  });
});

describe("the BOM", () => {
  it("is written when asked, so Excel reads the file as UTF-8", () => {
    expect(toCsv([["a"]], { bom: true }).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv([["a"]]).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("round-trips: the reader strips the BOM the writer emits", () => {
    expect(parseCsv(toCsv([["a", "b"]], { bom: true }))).toEqual([["a", "b"]]);
  });
});

describe("keepBlank", () => {
  it("keeps an interior blank record so row N is still row N", () => {
    // Dropping it would renumber every later row, and a row-numbered error
    // would point the planner at the wrong line of their spreadsheet.
    expect(parseCsv("h\n1\n\n3", { keepBlank: true })).toEqual([["h"], ["1"], [""], ["3"]]);
  });

  it("still drops TRAILING blank lines, which nobody numbered", () => {
    expect(parseCsv("h\n1\n\n\n", { keepBlank: true })).toEqual([["h"], ["1"]]);
  });
});
