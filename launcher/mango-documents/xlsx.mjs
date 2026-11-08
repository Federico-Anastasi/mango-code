// Markdown -> Excel (.xlsx) with `exceljs`: each heading opens a sheet, each table fills its rows.
// Formulas are real formulas; their results are computed here (fast-formula-parser) and saved next to
// them, so even whoever opens the file without recalculating (previews, the model reading it) sees the numbers.
import ExcelJS from "exceljs";
import FormulaParser from "fast-formula-parser";
import { blocks, chartType, columnLetters, directive, plainText, resolveStyle } from "./common.mjs";
import { injectCharts } from "./chart-xlsx.mjs";

const INVALID_SHEET_NAME = /[\\/?*[\]:]/g;

export const FORMATS = {
  euro: '#,##0.00 "€"',
  percent: "0.0%",
  number: "#,##0.00",
  integer: "#,##0",
  date: "dd/mm/yyyy",
  text: "@",
};
/** «euro», «percent»... or an Excel format written out in full. */
export const formatCode = (f) => FORMATS[String(f).toLowerCase()] ?? f;

/** Text of a cell -> Excel value: formula, number, percentage, euro amount, ISO date or text. */
export function cellValue(text) {
  const t = text.trim();
  if (/^=.{2,}/.test(t)) return { value: { formula: t.slice(1) } };
  if (/^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t)) return { value: Number(t) };
  if (/^-?\d+(\.\d+)?%$/.test(t)) return { value: Number(t.slice(0, -1)) / 100, format: FORMATS.percent };
  const euro = t.match(/^(?:€\s*(-?\d+(?:\.\d+)?)|(-?\d+(?:\.\d+)?)\s*€)$/);
  if (euro) return { value: Number(euro[1] ?? euro[2]), format: FORMATS.euro };
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const d = new Date(`${t}T00:00:00Z`);
    if (!Number.isNaN(d.getTime()) && d.toISOString().startsWith(t)) return { value: d, format: FORMATS.date };
  }
  // Written the Italian way (1.250,50 / 12,5): it is not guessed, it stays text, but a warning is given.
  if (/^-?(\d{1,3}(\.\d{3})+|\d+),\d+$/.test(t) || /^-?\d{1,3}(\.\d{3})+$/.test(t)) {
    return { value: t, warning: `«${t}» stayed text: for a number use the decimal point and no thousands separator (${t.replace(/\./g, "").replace(",", ".")})` };
  }
  return { value: t };
}

/** A value passed in JSON by the model (number, text, boolean, «=formula», ISO date) -> Excel value. */
export function valueFromJson(v) {
  if (v === null || v === undefined || v === "") return { value: null };
  if (typeof v === "number" || typeof v === "boolean") return { value: v };
  return cellValue(String(v));
}

export function sheetName(title, used) {
  const base = title.replace(INVALID_SHEET_NAME, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

const BORDER = { style: "thin", color: { argb: "FFBFBFBF" } };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

/** Writes a table row at the bottom of the sheet. Pushes the cell warnings onto `warnings`. */
function writeRow(sheet, cells, header, s, warnings) {
  const row = sheet.addRow(cells.map(() => null));
  cells.forEach((text, i) => {
    const c = row.getCell(i + 1);
    const { value, format, warning } = header ? { value: text.trim() } : cellValue(text);
    c.value = value;
    if (format) c.numFmt = format;
    if (warning) warnings.push(`${c.address}: ${warning}`);
    c.border = BORDERS;
  });
  if (header) {
    row.font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${s.primary}` } }; c.alignment = { vertical: "middle" }; });
  }
  return row;
}

/**
 * Writes a table (headers and text rows) at the bottom of the sheet: coloured header, frozen row,
 * filter on the first table. Returns the description of the table (for charts).
 */
export function writeTable(sheet, headers, rows, s, warnings, { filter = true } = {}) {
  if (sheet.rowCount > 0) sheet.addRow([]); // empty row between one table and the next
  const headerRow = writeRow(sheet, headers, true, s, warnings);
  if (!sheet.views.length) sheet.views = [{ state: "frozen", ySplit: headerRow.number }];
  for (const r of rows) writeRow(sheet, headers.map((_, i) => r[i] ?? ""), false, s, warnings);
  if (filter && rows.length) {
    sheet.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: headerRow.number + rows.length, column: headers.length } };
  }
  return { dataRows: rows.length, headerRow: headerRow.number, columns: headers.length, titles: [...headers] };
}

/**
 * Fills a sheet with the Markdown blocks (tables, lists, text). `charts` collects the
 * `[[chart: ...]]` requests, `warnings` the cell warnings.
 */
function fillSheet(sheet, toks, s, warnings, charts) {
  let last = null;
  let firstFilter = true;
  for (const t of toks) {
    if (t.type === "table") {
      last = writeTable(sheet, t.header.map((c) => plainText(c.tokens)), t.rows.map((r) => t.header.map((_, i) => plainText(r[i]?.tokens))), s, warnings, { filter: firstFilter });
      firstFilter = false; // one filter per sheet
    } else if (t.type === "list") {
      for (const v of t.items) writeRow(sheet, [plainText(v.tokens)], false, s, warnings);
    } else if (t.type === "paragraph" || t.type === "text" || t.type === "code") {
      const d = t.type === "paragraph" ? directive(t) : null;
      if (d?.name === "chart") {
        if (!last) throw new Error("[[chart: ...]] must come right after the table with the data");
        charts.push({ sheet: sheet.name, type: chartType(d), title: d.title, table: last });
      } else if (d?.name === "page") {
        // a page break makes no sense in spreadsheets: ignored
      } else {
        writeRow(sheet, [t.type === "paragraph" ? plainText(t.tokens) : t.text], false, s, warnings);
      }
    }
  }
}

export function fitColumns(sheet) {
  (sheet.columns ?? []).forEach((col) => {
    let max = 8;
    col.eachCell({ includeEmpty: false }, (c) => {
      const v = c.value;
      const len = v instanceof Date ? 10 : typeof v === "object" && v ? (v.formula ? Math.min(String(v.result ?? "").length || 10, 14) : String(v.richText?.map((r) => r.text).join("") ?? "").length) : String(v ?? "").length;
      max = Math.max(max, len);
    });
    col.width = Math.min(60, max + 3);
  });
}

// ---------------------------------------------------------------------------------------------
// Formula calculation
// ---------------------------------------------------------------------------------------------

const EXCEL_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);
const SERIAL_ZERO = Date.UTC(1899, 11, 30);
const toSerial = (d) => (d.getTime() - SERIAL_ZERO) / 86400000;

/**
 * Computes all the formulas of the workbook and saves the result in the cell. Returns the warnings:
 * formulas that give an error (#DIV/0!...) or that the calculator cannot evaluate (they are
 * saved anyway, Excel recalculates them on opening).
 */
export function recalculate(wb) {
  const warnings = [];
  const memo = new Map();
  const inProgress = new Set();
  const key = (sheet, r, c) => `${sheet}\u0000${r}\u0000${c}`;

  const valueOf = (sheetName, r, c) => {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) return new FormulaParser.FormulaError("#REF!");
    const cell = ws.getCell(r, c);
    const v = cell.value;
    if (v && typeof v === "object" && !(v instanceof Date) && (v.formula || v.sharedFormula)) return calculate(ws, cell);
    if (v instanceof Date) return toSerial(v);
    if (v && typeof v === "object") {
      if (v.richText) return v.richText.map((x) => x.text).join("");
      if (v.text !== undefined) return v.text; // link
      if (v.error) return new FormulaParser.FormulaError(v.error);
    }
    return v ?? null;
  };

  const parser = new FormulaParser({
    onCell: ({ sheet, row, col }) => valueOf(sheet, row, col),
    onRange: ({ sheet, from, to }) => {
      const rows = [];
      for (let r = from.row; r <= to.row; r++) {
        const row = [];
        for (let c = from.col; c <= to.col; c++) row.push(valueOf(sheet, r, c));
        rows.push(row);
      }
      return rows;
    },
  });

  function calculate(ws, cell) {
    const k = key(ws.name, cell.row, cell.col);
    if (memo.has(k)) return memo.get(k);
    if (inProgress.has(k)) return new FormulaParser.FormulaError("#REF!"); // circular reference
    inProgress.add(k);
    let outcome;
    try {
      outcome = parser.parse(cell.formula, { sheet: ws.name, row: Number(cell.row), col: Number(cell.col) });
    } catch (e) {
      outcome = e instanceof FormulaParser.FormulaError ? e : undefined;
      if (outcome === undefined) outcome = { notEvaluable: String(e?.message ?? e) };
    }
    inProgress.delete(k);
    memo.set(k, outcome);
    return outcome;
  }

  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (!v || typeof v !== "object" || v instanceof Date || !(v.formula || v.sharedFormula)) return;
        const outcome = calculate(ws, cell);
        const formula = cell.formula;
        const where = `${ws.name}!${cell.address}`;
        if (outcome instanceof FormulaParser.FormulaError) {
          // Excel accepts only these error codes: the others (invalid formula) are for it an unknown name.
          const raw = outcome.error ?? String(outcome);
          const err = EXCEL_ERRORS.has(raw) ? raw : "#NAME?";
          cell.value = { formula, result: { error: err } };
          const hint = err === "#NAME?" ? " (invalid formula or unknown function: use the English function names, e.g. SUM, IF, and the comma as separator)" : "";
          warnings.push(`${where}: the formula =${formula} gives the error ${err}${hint}`);
        } else if (outcome && typeof outcome === "object" && outcome.notEvaluable !== undefined) {
          // Left as it is (with the result already saved, if any): Excel recalculates it on opening.
          warnings.push(`${where}: could not verify =${formula}`);
        } else if (Array.isArray(outcome)) {
          // array formula: left to Excel
        } else {
          cell.value = { formula, result: outcome === null || outcome === undefined ? 0 : outcome };
        }
      });
    });
  }
  return warnings;
}

export async function createXlsx(markdown, { styleName }) {
  const s = resolveStyle(styleName);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mango Code";
  wb.calcProperties.fullCalcOnLoad = true;
  const used = new Set();
  const warnings = [];
  const charts = [];

  // The Markdown is split into sections: each heading opens a sheet.
  const sections = [];
  for (const t of blocks(markdown)) {
    if (t.type === "heading") sections.push({ title: plainText(t.tokens), toks: [] });
    else {
      if (!sections.length) sections.push({ title: "Sheet1", toks: [] });
      sections.at(-1).toks.push(t);
    }
  }
  for (const sec of sections) {
    const ws = wb.addWorksheet(sheetName(sec.title, used));
    fillSheet(ws, sec.toks, s, warnings, charts);
  }
  if (!wb.worksheets.some((ws) => ws.rowCount > 0)) throw new Error("the content is empty: at least one Markdown table is needed");
  for (const ws of wb.worksheets) fitColumns(ws);

  warnings.push(...recalculate(wb));
  let data = Buffer.from(await wb.xlsx.writeBuffer());
  if (charts.length) data = await injectCharts(data, charts.map((g) => chartFromTable(g, wb, s)));
  return { data, warnings };
}

/** Description of a chart (cell references and already computed values) from a written table. */
export function chartFromTable({ sheet, type, title, table }, wb, s) {
  const ws = wb.getWorksheet(sheet);
  const r1 = table.headerRow + 1, r2 = table.headerRow + table.dataRows;
  if (table.dataRows < 1) throw new Error("the chart needs a table with at least one data row");
  if (table.columns < 2) throw new Error("the chart needs a table with at least two columns: labels and numbers");
  const c0 = table.startColumn ?? 1;
  const valueAt = (r, c) => {
    const v = ws.getCell(r, c).value;
    if (v && typeof v === "object" && !(v instanceof Date)) return v.result ?? (v.richText ? v.richText.map((x) => x.text).join("") : null);
    return v;
  };
  const categories = [];
  for (let r = r1; r <= r2; r++) categories.push(String(valueAt(r, c0) ?? ""));
  const series = [];
  const lastColumn = c0 + (type === "pie" ? 1 : table.columns - 1);
  for (let c = c0 + 1; c <= lastColumn; c++) {
    const values = [];
    for (let r = r1; r <= r2; r++) {
      const v = valueAt(r, c);
      values.push(typeof v === "number" ? v : null);
    }
    if (values.every((v) => v === null)) {
      throw new Error(`the chart uses column ${columnLetters(c)} («${table.titles[c - c0]}»), which contains no numbers. For a chart the first column is the labels and the others only numbers: put the chart after a table like that (even a separate table with just the data to show)`);
    }
    series.push({ name: table.titles[c - c0], nameRef: `${columnLetters(c)}${table.headerRow}`, valuesRef: `${columnLetters(c)}${r1}:${columnLetters(c)}${r2}`, values });
  }
  return {
    sheet, type, title, categories, series,
    categoriesRef: `${columnLetters(c0)}${r1}:${columnLetters(c0)}${r2}`,
    color: s.primary,
    anchor: table.anchor ?? { column: c0 + table.columns, row: table.headerRow - 1 },
  };
}

/** Fills a (new) sheet with Markdown: used by `add_sheet` in edits. */
export function sheetFromMarkdown(wb, title, markdown, styleName) {
  const s = resolveStyle(styleName);
  const used = new Set(wb.worksheets.map((w) => w.name.toLowerCase()));
  const ws = wb.addWorksheet(sheetName(title, used));
  const warnings = [];
  const charts = [];
  fillSheet(ws, blocks(markdown).filter((t) => t.type !== "heading"), s, warnings, charts);
  if (ws.rowCount === 0) throw new Error("the sheet content is empty: a Markdown table is needed");
  fitColumns(ws);
  return { ws, warnings, charts };
}
