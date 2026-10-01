// A CSV reader and writer for spreadsheet exports: quoted fields, "" for a
// literal quote, CRLF or LF, and the BOM Excel writes in front of UTF-8.
//
// Copied from mes-master-data's web/src/lib/csv.ts and extended with the three
// things the job plan template needs and that file did not:
//
//   A DELIMITER. The template is `;`-separated, because the plants' spreadsheets
//   run in an Indonesian locale — where `,` is the DECIMAL separator, so Excel
//   both writes and expects `;` between fields. A `,`-separated template would
//   open as one column per row there.
//   A BOM ON WRITE, not just a strip on read. Without it Excel reads the file as
//   the system code page, and any product name with a character outside ASCII —
//   an en dash, an accented letter — comes back as mojibake.
//   BLANK RECORDS ON REQUEST. The master-data reader drops them, which is right
//   for an import that ignores position — and wrong for one that reports errors
//   by ROW NUMBER, where dropping a blank row renumbers every row after it and
//   points the planner at the wrong line of their spreadsheet.

type ParseOptions = {
  delimiter?: string;
  // Keep blank records (returned as `[""]`), so record N is still row N.
  keepBlank?: boolean;
};

function parseCsv(text: string, { delimiter = ",", keepBlank = false }: ParseOptions = {}) {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // A doubled quote is an escaped one; a lone quote closes the field.
      if (input[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // A file that does not end in a newline still has one last row in hand.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const isBlank = (r: string[]) => r.every((cell) => cell.trim() === "");

  if (keepBlank) {
    // TRAILING blank lines are still dropped — they are an artefact of how the
    // file was saved, not rows anybody numbered.
    while (rows.length > 0 && isBlank(rows.at(-1)!)) rows.pop();
    return rows;
  }
  return rows.filter((r) => !isBlank(r));
}

type WriteOptions = {
  delimiter?: string;
  // Prefix a UTF-8 BOM, so Excel reads the file as UTF-8. See the header.
  bom?: boolean;
};

function toCsv(rows: string[][], { delimiter = ",", bom = false }: WriteOptions = {}): string {
  const needsQuoting = (cell: string) =>
    cell.includes(delimiter) || cell.includes('"') || cell.includes("\n") || cell.includes("\r");

  const body = rows
    .map((row) =>
      row
        .map((cell) => (needsQuoting(cell) ? `"${cell.replaceAll('"', '""')}"` : cell))
        .join(delimiter),
    )
    .join("\r\n");
  return bom ? `﻿${body}` : body;
}

export { parseCsv, toCsv };
