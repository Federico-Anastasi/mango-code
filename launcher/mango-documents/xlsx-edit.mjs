// Existing Excel (.xlsx): reading with formulas and values, and edits that keep formulas, formats and charts.
// It is opened with `exceljs`, only what the operation says is changed, the formulas are recalculated and it is saved;
// the charts (which exceljs does not know) are put back after saving.
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  MAX_READ, columnLetters, columnNumber, requireParams, resolveStyle,
} from "./common.mjs";
import {
  formatCode, sheetFromMarkdown, chartFromTable, recalculate, valueFromJson,
} from "./xlsx.mjs";
import { anchorFrom, sheetsWithCharts, injectCharts, unpreservableParts, restoreCharts } from "./chart-xlsx.mjs";
import { tableProfile } from "./profile.mjs";

/** Above this size exceljs would use too much memory: the file is read as a stream and not edited. */
const MAX_EDIT_BYTES = 15 * 1024 * 1024;

const COLORS = {
  yellow: "FFFF00", red: "FF0000", green: "00B050", blue: "0070C0", orange: "FFC000",
  gray: "D9D9D9", grey: "D9D9D9", black: "000000", white: "FFFFFF", lightblue: "9DC3E6", pink: "FFC0CB", purple: "7030A0",
};

const CHART_KINDS = ["bar", "horizontal", "line", "pie"];

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

export function parseCell(text) {
  const m = String(text).trim().match(/^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/);
  if (!m) throw new Error(`«${text}» is not a cell: write for example B2`);
  return { c: columnNumber(m[1]), r: Number(m[2]) };
}
export function parseRange(text) {
  const parts = String(text).trim().split(":");
  if (parts.length > 2) throw new Error(`«${text}» is not a range: write for example A1:D9`);
  const a = parseCell(parts[0]), b = parseCell(parts[1] ?? parts[0]);
  return { c1: Math.min(a.c, b.c), r1: Math.min(a.r, b.r), c2: Math.max(a.c, b.c), r2: Math.max(a.r, b.r) };
}
const address = (c, r) => `${columnLetters(c)}${r}`;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const round = (n) => (Number.isFinite(n) ? Number(n.toPrecision(12)) : n);

function valueText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (typeof v === "number") return String(round(v));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (v.error) return v.error;
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.hyperlink !== undefined) return valueText(v.text ?? v.hyperlink);
    if (v.result !== undefined) return valueText(v.result);
  }
  return String(v);
}

function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (cell.type === ExcelJS.ValueType.Formula) {
    const f = `=${cell.formula}`;
    // The result is read from the cell: `value` drops the «false» results (0, false).
    return cell.result === undefined ? f : `${f} → ${valueText(cell.result)}`;
  }
  return valueText(v);
}

const cleanCell = (t) => t.replace(/\|/g, "\\|").replace(/\r?\n/g, " ↵ ");

/** Extent actually used by a sheet: first/last row and column with content. */
export function usedArea(ws) {
  let r1 = Infinity, r2 = 0, c1 = Infinity, c2 = 0;
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (cell.value === null || cell.value === undefined || cell.value === "") return;
      r1 = Math.min(r1, n); r2 = Math.max(r2, n); c1 = Math.min(c1, c); c2 = Math.max(c2, c);
    });
  });
  return r2 ? { r1, r2, c1, c2 } : null;
}

async function loadWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(file);
  } catch {
    throw new Error(`${path.basename(file)} is not a real Excel (.xlsx) file: it is damaged, password-protected or has the wrong extension`);
  }
  return wb;
}

function findSheet(wb, name) {
  const ws = wb.worksheets.find((w) => w.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!ws) throw new Error(`the sheet «${name}» does not exist: the sheets are ${wb.worksheets.map((w) => `«${w.name}»`).join(", ")}`);
  return ws;
}
function sheetOf(wb, op) {
  if (op.sheet) return findSheet(wb, op.sheet);
  if (wb.worksheets.length === 1) return wb.worksheets[0];
  throw new Error(`name the sheet with «sheet»: the sheets are ${wb.worksheets.map((w) => `«${w.name}»`).join(", ")}`);
}

function describeProfile(p) {
  const lines = [`Large Excel file (${Math.round(p.bytes / 1048576)} MB): reading only its profile, without opening all of it.`];
  for (const f of p.sheets) {
    lines.push(`\nSheet «${f.name}»: ${f.rows}${f.rows_exact ? "" : "+"} rows, ${f.columns.length} columns`);
    lines.push(f.columns.map((c) => `${c.letter} ${c.name || "(no name)"} [${c.type}]`).join(" · "));
    for (const r of f.first_rows) lines.push(`  ${r.map((x) => (x === null ? "" : String(x))).join(" | ")}`);
  }
  lines.push("\nAnalysis of the whole data needs a spreadsheet program: from here only the first rows can be read.");
  return lines.join("\n");
}

export async function read(file, { part } = {}) {
  const size = fs.statSync(file).size;
  if (size > MAX_EDIT_BYTES) {
    const outcome = await tableProfile(file);
    if (!outcome.ok) throw new Error(outcome.reason);
    return describeProfile(outcome.profile);
  }
  const wb = await loadWorkbook(file);
  if (!wb.worksheets.length) throw new Error("the file has no sheets");

  // part = «Sheet», «Sheet!A50:F120» or just «A50:F120»
  let partName, range;
  if (part) {
    const m = String(part).match(/^(?:(.*)!)?([A-Za-z]{1,3}\d+(?::[A-Za-z]{1,3}\d+)?)$/);
    if (m) { partName = m[1]; range = parseRange(m[2]); } else partName = String(part);
  }
  if (range && !partName && wb.worksheets.length > 1) throw new Error("with more than one sheet also write the name: Sheet!A50:F120");
  const sheets = partName ? [findSheet(wb, partName)] : wb.worksheets;

  const buf = fs.readFileSync(file);
  const withCharts = new Set(await sheetsWithCharts(buf));
  const output = [`Excel workbook: ${path.basename(file)} — ${wb.worksheets.length} ${wb.worksheets.length === 1 ? "sheet" : "sheets"}: ${wb.worksheets.map((w) => `«${w.name}»`).join(", ")}`];
  let budget = MAX_READ;

  for (const ws of sheets) {
    const area = usedArea(ws);
    const tag = `Sheet «${ws.name}»${withCharts.has(ws.name) ? " (with charts)" : ""}`;
    if (!area) { output.push(`\n${tag}: empty`); continue; }
    const a = range ?? area;
    const r1 = range ? range.r1 : area.r1, r2 = range ? range.r2 : area.r2;
    const head = `${tag} — used area ${address(area.c1, area.r1)}:${address(area.c2, area.r2)}`;
    const columns = Array.from({ length: a.c2 - a.c1 + 1 }, (_, i) => a.c1 + i);
    const lines = [`\n${head}`, `| row | ${columns.map(columnLetters).join(" | ")} |`, `|${" --- |".repeat(columns.length + 1)}`];
    let lastPrinted = r1 - 1;
    for (let r = r1; r <= r2; r++) {
      const cells = columns.map((c) => cleanCell(cellText(ws.getCell(r, c))).slice(0, 80));
      if (cells.every((x) => x === "")) { lastPrinted = r; continue; }
      const line = `| ${r} | ${cells.join(" | ")} |`;
      budget -= line.length + 1;
      if (budget < 0) break;
      lines.push(line);
      lastPrinted = r;
    }
    if (lastPrinted < r2) lines.push(`… rows ${lastPrinted + 1}-${r2} not shown: continue with part="${ws.name}!${address(a.c1, lastPrinted + 1)}:${address(a.c2, r2)}"`);
    output.push(lines.join("\n"));
    if (budget < 0) {
      const remaining = sheets.slice(sheets.indexOf(ws) + 1).map((w) => `«${w.name}»`);
      if (remaining.length) output.push(`\nSheets not shown: ${remaining.join(", ")} (read them with part="sheet name")`);
      break;
    }
  }
  output.push("\nFormulas are shown as =FORMULA → result. Dates are in YYYY-MM-DD format.");
  return output.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/** Replaces {r}, {r-1}, {r+1} with row numbers. */
const withRow = (text, r) => text.replace(/\{r\s*([+-]\s*\d+)?\}/g, (_, d) => String(r + (d ? Number(d.replace(/\s/g, "")) : 0)));

function valueForCell(v, r) {
  const parsed = valueFromJson(typeof v === "string" ? withRow(v, r) : v);
  return parsed;
}

function writeValue(cell, v, r, warnings) {
  const { value, format, warning } = valueForCell(v, r);
  cell.value = value;
  if (format) restyle(cell, { numFmt: format });
  if (warning) warnings.push(`${cell.address}: ${warning}`);
}

function matrix(values, name = "values") {
  if (values === undefined || values === null) throw new Error(`missing parameter «${name}»`);
  if (typeof values === "string") {
    const t = values.trim();
    if (t.startsWith("[")) { try { return matrix(JSON.parse(t), name); } catch { /* it is a text that starts with [ */ } }
  }
  if (!Array.isArray(values)) return [[values]];
  if (values.every((x) => !Array.isArray(x))) return [values]; // a simple list = one row
  return values.map((row) => (Array.isArray(row) ? row : [row]));
}

/**
 * The styles of cells read from a file are objects SHARED among all the cells with the same format:
 * `cell.numFmt = x` or `cell.fill = x` would change them in all of them. Always assign a whole new style.
 */
function restyle(cell, partial = {}) {
  cell.style = { ...JSON.parse(JSON.stringify(cell.style ?? {})), ...partial };
}
function copyStyle(from, to) {
  to.style = JSON.parse(JSON.stringify(from.style ?? {}));
}

const BORDER = { style: "thin", color: { argb: "FFBFBFBF" } };

function argbColor(text, what) {
  const t = String(text).trim().toLowerCase();
  const hex = COLORS[t] ?? (/^#?[0-9a-f]{6}$/.test(t) ? t.replace("#", "").toUpperCase() : null);
  if (!hex) throw new Error(`${what} «${text}» is not a color: write a name (${Object.keys(COLORS).join(", ")}) or a code like FFFF00`);
  return `FF${hex}`;
}

export async function edit(file, ops, { styleName }) {
  const size = fs.statSync(file).size;
  if (size > MAX_EDIT_BYTES) throw new Error(`the file is too large to edit safely (${Math.round(size / 1048576)} MB, the limit is ${MAX_EDIT_BYTES / 1048576} MB): use documents_read to look at it and make the change in Excel`);
  const original = fs.readFileSync(file);
  const lost = await unpreservableParts(original);
  if (lost.length) throw new Error(`the file contains ${lost.join(" and ")}, which this edit would delete. Ask the user to make this change in Excel`);

  const wb = await loadWorkbook(file);
  wb.calcProperties.fullCalcOnLoad = true;
  const summary = [];
  const warnings = [];
  const charts = []; // chart requests, resolved after the recalculation

  for (const [i, op] of ops.entries()) {
    const label = `operation ${i + 1} («${op.action}»)`;
    try {
      switch (op.action) {
        case "set": {
          requireParams(op, "cell");
          const ws = sheetOf(wb, op);
          const { c, r } = parseCell(op.cell);
          const m = matrix(op.values);
          m.forEach((row, dy) => row.forEach((v, dx) => writeValue(ws.getCell(r + dy, c + dx), v, r + dy, warnings)));
          const width = Math.max(...m.map((x) => x.length));
          summary.push(`set ${m.length * width} cells in «${ws.name}» from ${address(c, r)} to ${address(c + width - 1, r + m.length - 1)}`);
          break;
        }
        case "add_rows": {
          const ws = sheetOf(wb, op);
          const m = matrix(op.rows, "rows");
          const area = usedArea(ws);
          const last = area?.r2 ?? 0;
          const first = area?.r1 ?? 1;
          m.forEach((row, k) => {
            const r = last + 1 + k;
            const above = last + k;
            row.forEach((v, dx) => {
              const cell = ws.getCell(r, (area?.c1 ?? 1) + dx);
              // The row above gives the format template, but not if it is the header (colors, bold).
              const template = above > first ? ws.getCell(above, (area?.c1 ?? 1) + dx) : null;
              if (template) copyStyle(template, cell); else restyle(cell, { border: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER } });
              const t = typeof v === "string" ? withRow(v, r) : v;
              writeValue(cell, t, r, warnings);
            });
          });
          if (ws.autoFilter && typeof ws.autoFilter === "object" && ws.autoFilter.to) ws.autoFilter.to.row = Math.max(ws.autoFilter.to.row, last + m.length);
          if (ws.tables && Object.keys(ws.tables).length) warnings.push(`«${ws.name}» contains an Excel Table: the new rows are written below it but the Table may not include them`);
          summary.push(`added ${m.length} rows in «${ws.name}» (rows ${last + 1}-${last + m.length})`);
          break;
        }
        case "add_column": {
          requireParams(op, "header");
          const ws = sheetOf(wb, op);
          const area = usedArea(ws);
          if (!area) throw new Error(`the sheet «${ws.name}» is empty`);
          const c = area.c2 + 1;
          const headerCell = ws.getCell(area.r1, c);
          headerCell.value = String(op.header);
          copyStyle(ws.getCell(area.r1, area.c2), headerCell);
          let from = area.r1 + 1, to = area.r2;
          if (op.rows !== undefined && op.rows !== null && op.rows !== "") {
            const mm = String(op.rows).match(/^(\d+)(?:\s*-\s*(\d+))?$/);
            if (!mm) throw new Error(`«rows» must be a range of rows like 2-9, not «${op.rows}»`);
            from = Number(mm[1]); to = Number(mm[2] ?? mm[1]);
          }
          if (from <= area.r1) throw new Error(`the data rows start from ${area.r1 + 1}: ${area.r1} is the header`);
          const list = Array.isArray(op.values) ? op.values : null;
          if (list && list.length !== to - from + 1) throw new Error(`«values» has ${list.length} elements but rows ${from}-${to} are ${to - from + 1}: give a single formula with {r} for all of them, or one value per row`);
          if (!list && (op.values === undefined || op.values === null)) throw new Error("missing «values»: a formula like =B{r}*C{r} for all the rows, or a list with one value per row");
          for (let r = from; r <= to; r++) {
            const cell = ws.getCell(r, c);
            copyStyle(ws.getCell(r, area.c2), cell);
            writeValue(cell, list ? list[r - from] : op.values, r, warnings);
            if (op.format) restyle(cell, { numFmt: formatCode(op.format) });
          }
          ws.getColumn(c).width = Math.max(12, String(op.header).length + 3);
          if (ws.autoFilter && typeof ws.autoFilter === "object" && ws.autoFilter.to) ws.autoFilter.to.column = Math.max(ws.autoFilter.to.column, c);
          summary.push(`added column ${columnLetters(c)} «${op.header}» in «${ws.name}» (rows ${from}-${to})`);
          break;
        }
        case "add_sheet": {
          requireParams(op, "name", "markdown");
          const { ws, warnings: w, charts: ch } = sheetFromMarkdown(wb, op.name, String(op.markdown), styleName);
          warnings.push(...w);
          charts.push(...ch);
          summary.push(`added the sheet «${ws.name}»${ws.name !== op.name ? ` (the name «${op.name}» was not allowed or already used)` : ""}`);
          break;
        }
        case "format": {
          requireParams(op, "range");
          const ws = sheetOf(wb, op);
          const { c1, r1, c2, r2 } = parseRange(op.range);
          if ((c2 - c1 + 1) * (r2 - r1 + 1) > 200000) throw new Error("range too large");
          const color = op.color !== undefined ? argbColor(op.color, "the text color") : null;
          const fill = op.fill !== undefined ? argbColor(op.fill, "the fill") : null;
          if (op.format === undefined && op.bold === undefined && !color && !fill) throw new Error("you asked for no change: give format, bold, fill or color");
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
            const cell = ws.getCell(r, c);
            const next = {};
            if (op.format !== undefined) next.numFmt = formatCode(op.format);
            if (op.bold !== undefined || color) next.font = { ...(cell.font ?? {}), ...(op.bold !== undefined ? { bold: !!op.bold } : {}), ...(color ? { color: { argb: color } } : {}) };
            if (fill) next.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
            restyle(cell, next);
          }
          summary.push(`formatted ${op.range} in «${ws.name}»`);
          break;
        }
        case "clear": {
          requireParams(op, "range");
          const ws = sheetOf(wb, op);
          const { c1, r1, c2, r2 } = parseRange(op.range);
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) ws.getCell(r, c).value = null;
          summary.push(`cleared ${op.range} in «${ws.name}» (formats kept; formulas pointing here now see empty cells)`);
          break;
        }
        case "replace": {
          requireParams(op, "find");
          if (op.with === undefined || op.with === null) throw new Error("missing «with» (the new text; it can be empty)");
          const sheets = op.sheet ? [findSheet(wb, op.sheet)] : wb.worksheets;
          let n = 0;
          for (const ws of sheets) ws.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
            if (typeof cell.value === "string" && cell.value.includes(op.find)) { cell.value = cell.value.split(op.find).join(String(op.with)); n++; }
          }));
          if (!n) throw new Error(`the text «${op.find}» is not in any text cell (formulas are not touched: change them with set)`);
          summary.push(`«${op.find}» → «${op.with}»: ${n} cells`);
          break;
        }
        case "chart": {
          requireParams(op, "range", "type");
          const ws = sheetOf(wb, op);
          const { c1, r1, c2, r2 } = parseRange(op.range);
          if (r2 - r1 < 1 || c2 - c1 < 1) throw new Error("the chart range must have the header row, the labels column and at least one column of numbers: e.g. A1:C6");
          const titles = Array.from({ length: c2 - c1 + 1 }, (_, k) => valueText(ws.getCell(r1, c1 + k).result ?? ws.getCell(r1, c1 + k).value));
          const table = { startColumn: c1, headerRow: r1, dataRows: r2 - r1, columns: c2 - c1 + 1, titles };
          if (op.position) table.anchor = anchorFrom(op.position);
          charts.push({ sheet: ws.name, type: op.type, title: op.title ?? "", table });
          summary.push(`added a ${op.type} chart of the data ${op.range} in «${ws.name}»`);
          break;
        }
        default:
          throw new Error(`action «${op.action}» does not exist for an Excel file: use set, add_rows, add_column, add_sheet, format, clear, replace, chart`);
      }
    } catch (e) {
      throw new Error(`${label}: ${e.message}. Nothing was saved.`);
    }
  }

  warnings.push(...recalculate(wb));
  const resolvedCharts = charts.map((g) => {
    if (!CHART_KINDS.includes(g.type)) throw new Error(`chart «${g.type}»: use bar, line, pie or horizontal`);
    return chartFromTable(g, wb, resolveStyle(styleName));
  });
  let data = Buffer.from(await wb.xlsx.writeBuffer());
  if ((await sheetsWithCharts(original)).length) data = await restoreCharts(original, data);
  if (resolvedCharts.length) data = await injectCharts(data, resolvedCharts);
  return { data, summary, warnings };
}
