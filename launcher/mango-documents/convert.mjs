// Conversions possible WITHOUT Word, Excel or LibreOffice:
//   docx -> pdf  and  xlsx -> pdf   simplified version: the text and the structure (headings, lists, tables, images)
//                                   are rebuilt with the style of our PDFs; original fonts, colors and layout are not kept
//   xlsx -> csv                     one file per sheet (or the chosen sheet), with the formula results
//   csv  -> xlsx                    table with header, real numbers and real dates
// The others (pptx -> pdf, pdf -> docx...) have no decent result without an Office program: they are refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import FormulaParser from "fast-formula-parser";
import { existingFile, escapeMarkdown, resolveStyle } from "./common.mjs";
import { documentAsMarkdown, joinBlocks } from "./docx-edit.mjs";
import { createPdf } from "./pdf.mjs";
import { writeTable } from "./xlsx.mjs";
import { usedArea } from "./xlsx-edit.mjs";

const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_PDF_ROWS = 3000;
const NOT_POSSIBLE = {
  "pptx->pdf": "PowerPoint exports to PDF with File > Save As > PDF: without PowerPoint the slides cannot be drawn faithfully. If only the text is needed, use documents_read and then documents_create with type pdf",
  "pdf->docx": "a PDF does not have the structure of a Word document (paragraphs, tables): without an Office program the result would be unreadable. The text can be read with documents_read and the document redone with documents_create",
  "pdf->xlsx": "the cells cannot be rebuilt reliably from the tables of a PDF: read the text with documents_read and rewrite the data with documents_create",
};

const destinationOf = (file, saveAs, extension, suffix = "") => {
  if (saveAs) {
    if (!path.isAbsolute(saveAs)) throw new Error(`«${saveAs}» is not a full path`);
    return path.extname(saveAs).toLowerCase() === `.${extension}` ? saveAs : `${saveAs}.${extension}`;
  }
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}${suffix}.${extension}`);
};

const overwriteNote = (filePath) => (fs.existsSync(filePath) ? `a file with that name already existed: it was replaced` : "");

// ---------------------------------------------------------------------------------------------

async function docxToPdf({ file, saveAs }) {
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-conv-"));
  try {
    const { blocks } = await documentAsMarkdown(file, { imageDir, escape: true });
    if (!blocks.length) throw new Error("the document has no content to convert");
    const data = await createPdf(joinBlocks(blocks), { dir: imageDir });
    const d = destinationOf(file, saveAs, "pdf");
    return {
      files: [{ path: d, data }],
      note: `simplified version: headings, lists, tables, images and bold/italic are rebuilt with the Mango style; the original fonts, colors, margins, headers and footers are not kept. For an identical copy the user opens the file in Word and uses Save as PDF. ${overwriteNote(d)}`.trim(),
    };
  } finally {
    fs.rmSync(imageDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------

const SSF = FormulaParser.SSF;
const SERIAL_ZERO = Date.UTC(1899, 11, 30);

/** How Excel shows the cell (number format included), with Italian separators. */
function visibleText(cell) {
  let v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date) && (v.formula || v.sharedFormula)) v = cell.result;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if (v.error) return v.error;
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.text !== undefined) return String(v.text);
    return "";
  }
  const fmt = cell.numFmt;
  if (v instanceof Date) {
    try { return SSF.format(fmt && fmt !== "General" ? fmt : "dd/mm/yyyy", (v.getTime() - SERIAL_ZERO) / 86400000); } catch { return v.toISOString().slice(0, 10); }
  }
  if (typeof v === "number") {
    try {
      const t = SSF.format(fmt && fmt !== "General" ? fmt : "General", v);
      return t.replace(/[.,]/g, (m) => (m === "." ? "," : "."));
    } catch { return String(v).replace(".", ","); }
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

async function xlsxToPdf({ file, saveAs, sheet }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = sheet ? wb.worksheets.filter((w) => w.name.toLowerCase() === sheet.toLowerCase()) : wb.worksheets;
  if (!sheets.length) throw new Error(`the sheet «${sheet}» does not exist: the sheets are ${wb.worksheets.map((w) => `«${w.name}»`).join(", ")}`);
  const warnings = [];
  const parts = [];
  let maxColumns = 0;
  for (const ws of sheets) {
    const area = usedArea(ws);
    if (!area) continue;
    const n = area.c2 - area.c1 + 1;
    maxColumns = Math.max(maxColumns, n);
    const rows = [];
    for (let r = area.r1; r <= area.r2; r++) {
      rows.push(Array.from({ length: n }, (_, k) => escapeMarkdown(visibleText(ws.getCell(r, area.c1 + k))).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")));
    }
    if (rows.length > MAX_PDF_ROWS + 1) { warnings.push(`sheet «${ws.name}»: printed the first ${MAX_PDF_ROWS} rows out of ${rows.length - 1}`); rows.length = MAX_PDF_ROWS + 1; }
    const [head, ...rest] = rows;
    parts.push(`## ${escapeMarkdown(ws.name)}\n\n| ${head.join(" | ")} |\n|${" --- |".repeat(n)}\n${rest.map((r) => `| ${r.join(" | ")} |`).join("\n")}`);
  }
  if (!parts.length) throw new Error("the file has no data to convert");
  const data = await createPdf(parts.join("\n\n"), { dir: path.dirname(file), landscape: maxColumns > 6 });
  const d = destinationOf(file, saveAs, "pdf");
  return { files: [{ path: d, data }], warnings, note: `simplified version: each sheet becomes a table (the first row is the header), with numbers formatted as in Excel; widths, colors and charts are not kept. ${overwriteNote(d)}`.trim() };
}

// ---------------------------------------------------------------------------------------------

function csvCells(text, sep) {
  const row = [];
  let cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') inQuotes = false; else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else cell += c;
  }
  row.push(cell);
  return row;
}

/** Rows of a CSV: a line break inside quotes does not end the row. */
function csvRows(text) {
  const rows = [];
  let from = 0, inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inQuotes = !inQuotes;
    else if (text[i] === "\n" && !inQuotes) { rows.push(text.slice(from, text[i - 1] === "\r" ? i - 1 : i)); from = i + 1; }
  }
  if (from < text.length) rows.push(text.slice(from));
  return rows.filter((r) => r !== "");
}

/** Text of a CSV cell -> text that `cellValue` can read (numbers with the point, ISO dates). */
function normalizeCell(t, decimalComma) {
  const x = t.trim();
  if (decimalComma) {
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(x)) return x.replace(/\./g, "").replace(",", ".");
    if (/^-?\d+,\d+$/.test(x)) return x.replace(",", ".");
    if (/^-?\d+(,\d+)?%$/.test(x)) return x.replace(",", ".");
  }
  const d = x.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (d) return `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`;
  return t;
}

async function csvToXlsx({ file, saveAs }) {
  if (fs.statSync(file).size > MAX_CSV_BYTES) throw new Error(`the CSV is too large (more than ${MAX_CSV_BYTES / 1048576} MB)`);
  const raw = fs.readFileSync(file);
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { text = new TextDecoder("windows-1252").decode(raw); }
  const textRows = csvRows(text.replace(/^﻿/, ""));
  if (textRows.length < 1) throw new Error("the CSV is empty");
  const sep = [";", "\t", ","].map((s) => ({ s, n: csvCells(textRows[0], s).length })).sort((a, b) => b.n - a.n)[0].s;
  const decimalComma = sep !== ",";
  const cells = textRows.map((r) => csvCells(r, sep).map((c) => normalizeCell(c, decimalComma)));
  const [head, ...rest] = cells;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mango Code";
  const name = path.basename(file, path.extname(file)).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Data";
  const ws = wb.addWorksheet(name);
  const warnings = [];
  writeTable(ws, head.map((x) => x.trim()), rest, resolveStyle(), warnings);
  (ws.columns ?? []).forEach((col) => {
    let max = 8;
    col.eachCell({ includeEmpty: false }, (c) => { max = Math.max(max, String(c.value instanceof Date ? "0000-00-00" : (c.value?.result ?? c.value ?? "")).length); });
    col.width = Math.min(60, max + 3);
  });
  const data = Buffer.from(await wb.xlsx.writeBuffer());
  const d = destinationOf(file, saveAs, "xlsx");
  return { files: [{ path: d, data }], warnings: warnings.slice(0, 10), note: `separator recognized «${sep === "\t" ? "tab" : sep}», ${rest.length} data rows; the first row is the header. ${overwriteNote(d)}`.trim() };
}

// ---------------------------------------------------------------------------------------------

const roundNumber = (n) => Number(n.toPrecision(12));

function csvValue(cell, sep) {
  let v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date) && (v.formula || v.sharedFormula)) v = cell.result;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) { const i = v.toISOString(); return i.endsWith("T00:00:00.000Z") ? i.slice(0, 10) : i.slice(0, 19).replace("T", " "); }
  if (typeof v === "number") return sep === ";" ? String(roundNumber(v)).replace(".", ",") : String(roundNumber(v));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") return v.error ?? v.richText?.map((r) => r.text).join("") ?? (v.text !== undefined ? String(v.text) : "");
  return String(v);
}

async function xlsxToCsv({ file, saveAs, sheet, separator }) {
  const sep = separator === "," ? "," : ";";
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = sheet ? wb.worksheets.filter((w) => w.name.toLowerCase() === sheet.toLowerCase()) : wb.worksheets;
  if (!sheets.length) throw new Error(`the sheet «${sheet}» does not exist: the sheets are ${wb.worksheets.map((w) => `«${w.name}»`).join(", ")}`);
  const output = [];
  for (const ws of sheets) {
    const area = usedArea(ws);
    if (!area) continue;
    const rows = [];
    for (let r = area.r1; r <= area.r2; r++) {
      rows.push(Array.from({ length: area.c2 - area.c1 + 1 }, (_, k) => {
        const t = csvValue(ws.getCell(r, area.c1 + k), sep);
        return t.includes(sep) || /["\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      }).join(sep));
    }
    const data = Buffer.from(`﻿${rows.join("\r\n")}\r\n`, "utf8");
    const single = sheets.length === 1 || sheet;
    const filePath = destinationOf(file, single ? saveAs : undefined, "csv", single ? "" : `-${ws.name.replace(/[\\/?*[\]:]/g, "_")}`);
    output.push({ path: filePath, data });
  }
  if (!output.length) throw new Error("the file has no data to convert");
  return {
    files: output,
    note: `${sep === ";" ? "separator «;» and decimal comma (opens well in Italian Excel)" : "separator «,» and decimal point"}; formulas hold their last result; dates in YYYY-MM-DD format. ${output.map((f) => overwriteNote(f.path)).filter(Boolean).join(" ")}`.trim(),
  };
}

export async function convert({ file, from, to, saveAs, sheet, separator }) {
  existingFile(file);
  const key = `${from}->${to}`;
  if (NOT_POSSIBLE[key]) throw new Error(`conversion ${key} is not possible: ${NOT_POSSIBLE[key]}`);
  const table = { "docx->pdf": docxToPdf, "xlsx->pdf": xlsxToPdf, "xlsx->csv": xlsxToCsv, "csv->xlsx": csvToXlsx };
  if (!table[key]) throw new Error(`conversion ${key} is not supported: the possible ones are docx->pdf, xlsx->pdf, xlsx->csv, csv->xlsx`);
  return table[key]({ file, saveAs, sheet, separator });
}
