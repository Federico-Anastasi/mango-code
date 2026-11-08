// Profile of a large table (.xlsx or .csv) read as a stream, without loading the file into memory.
// Taken from the `base` repo (src/documenti/profiloTabella.ts, same author), translated to JavaScript.
// Used by documents_read for large sheets, which exceljs would open taking gigabytes.
import { open } from "node:fs/promises";
const SAMPLE_ROWS = 200;
const MAX_CELL_CHARS = 80;
const DEFAULT_EXAMPLES = 5;
const DEFAULT_LIMIT_MS = 90000;
function shorten(value) {
  return value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value;
}
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e === "amp")
      return "&";
    if (e === "lt")
      return "<";
    if (e === "gt")
      return ">";
    if (e === "quot")
      return '"';
    if (e === "apos")
      return "'";
    return String.fromCodePoint(e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10));
  });
}
function columnIndex(letter) {
  return [...letter].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
}
function columnLetter(index) {
  let rest = index;
  let letter = "";
  while (rest > 0) {
    letter = String.fromCharCode(65 + (rest - 1) % 26) + letter;
    rest = Math.floor((rest - 1) / 26);
  }
  return letter;
}
async function readEntries(filePath, bytes) {
  const file = await open(filePath, "r");
  try {
    const readAt = async (position, length) => {
      const b = Buffer.alloc(length);
      await file.read(b, 0, length, position);
      return b;
    };
    const tailStart = Math.max(0, bytes - 65557);
    const tail = await readAt(tailStart, bytes - tailStart);
    const end = tail.lastIndexOf(Buffer.from([80, 75, 5, 6]));
    if (end === -1)
      throw new Error("not a zip file");
    const count = tail.readUInt16LE(end + 10);
    const size = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 65535 || size === 4294967295 || offset === 4294967295)
      throw new Error("the file uses 64-bit zip, which is not supported");
    const directory = await readAt(offset, size);
    const entries = new Map;
    let p = 0;
    for (let i = 0;i < count && directory.readUInt32LE(p) === 33639248; i++) {
      const method = directory.readUInt16LE(p + 10);
      const compressed = directory.readUInt32LE(p + 20);
      const name = directory.toString("utf-8", p + 46, p + 46 + directory.readUInt16LE(p + 28));
      const localOffset = directory.readUInt32LE(p + 42);
      const localHeader = await readAt(localOffset, 30);
      entries.set(name, { method, compressed, start: localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28) });
      p += 46 + directory.readUInt16LE(p + 28) + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
    }
    return entries;
  } finally {
    await file.close();
  }
}
function entryStream(filePath, entry) {
  const raw = Bun.file(filePath).slice(entry.start, entry.start + entry.compressed).stream();
  if (entry.method === 0)
    return raw;
  if (entry.method !== 8)
    throw new Error(`compression ${entry.method} not supported`);
  return raw.pipeThrough(new DecompressionStream("deflate-raw"));
}
async function textOf(filePath, entry) {
  if (!entry)
    return "";
  return await new Response(entryStream(filePath, entry)).text();
}
function cellsOfRow(row) {
  const cells = [];
  for (const m of row.matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = m[1];
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
    if (!ref)
      continue;
    const inner = m[2] ?? "";
    const inlineStr = /<is>([\s\S]*?)<\/is>/.exec(inner);
    const value = inlineStr ? [...inlineStr[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join("") : decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
    cells.push({
      column: columnIndex(ref[1]),
      type: /\bt="(\w+)"/.exec(attrs)?.[1] ?? "n",
      style: Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? 0),
      value
    });
  }
  return cells;
}
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function dateStyles(stili) {
  const custom = new Map;
  for (const m of stili.matchAll(/<numFmt\s+[^>]*?numFmtId="(\d+)"[^>]*?formatCode="([^"]*)"/g))
    custom.set(Number(m[1]), decodeEntities(m[2]));
  const cells = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stili)?.[1] ?? "";
  const dates = new Set;
  let index = 0;
  for (const m of cells.matchAll(/<xf\s+([^>]*?)(?:\/>|>)/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1])?.[1] ?? 0);
    const code = custom.get(id);
    const isDate = code !== undefined ? /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")) : BUILTIN_DATE_FORMATS.has(id);
    if (isDate)
      dates.add(index);
    index++;
  }
  return dates;
}
function dateFromSerial(serial) {
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}
async function scanSheet(filePath, entry, deadline) {
  const ROW_START = Buffer.from("<row ");
  const reader = entryStream(filePath, entry).getReader();
  const rowsToKeep = SAMPLE_ROWS + 1;
  let rows = 0;
  let tail = Buffer.alloc(0);
  let text = "";
  let collecting = true;
  const decoder = new TextDecoder("utf-8");
  let exact = true;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    const chunk = tail.length > 0 ? Buffer.concat([tail, value]) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    for (let p = chunk.indexOf(ROW_START);p !== -1; p = chunk.indexOf(ROW_START, p + ROW_START.length))
      rows++;
    tail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - (ROW_START.length - 1))));
    if (collecting) {
      text += decoder.decode(value, { stream: true });
      if (rows >= rowsToKeep || text.includes("</sheetData>"))
        collecting = false;
    }
    if (Date.now() > deadline) {
      exact = false;
      await reader.cancel();
      break;
    }
  }
  const body = text.slice(text.indexOf("<sheetData") + 1);
  const sample = body.split("<row ").slice(1, rowsToKeep + 1).map(cellsOfRow);
  return { rows, exact, sample };
}
async function sharedStrings(filePath, entry, indices) {
  const found = new Map;
  if (!entry || indices.size === 0)
    return found;
  const max = Math.max(...indices);
  const reader = entryStream(filePath, entry).getReader();
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  let n = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    rest += decoder.decode(value, { stream: true });
    for (let end = rest.indexOf("</si>");end !== -1; end = rest.indexOf("</si>")) {
      const si = rest.slice(0, end);
      if (indices.has(n))
        found.set(n, [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(""));
      rest = rest.slice(end + 5);
      n++;
      if (n > max) {
        await reader.cancel();
        return found;
      }
    }
  }
  return found;
}
function typeOf(cell, dates) {
  if (cell.type === "b")
    return "boolean";
  if (cell.type === "e")
    return "error";
  if (cell.type === "d")
    return "date";
  if (cell.type === "n")
    return dates.has(cell.style) ? "date" : "number";
  return "text";
}
function valueOf(cell, dates, shared) {
  if (cell.type === "s")
    return shorten(shared.get(Number(cell.value)) ?? "");
  if (cell.type === "b")
    return cell.value === "1";
  if (cell.type === "n") {
    if (cell.value === "")
      return null;
    const number = Number(cell.value);
    return dates.has(cell.style) && Number.isFinite(number) ? dateFromSerial(number) : number;
  }
  return shorten(cell.value);
}
function columnType(types) {
  if (types.size === 0)
    return "empty";
  return types.size === 1 ? [...types][0] : "mixed";
}
function sheetProfile(scanned, dates, shared, examples) {
  const width = Math.max(0, ...scanned.sample.flatMap((row) => row.map((c) => c.column)));
  const asRow = (row) => {
    const values = Array.from({ length: width }, () => null);
    for (const cell of row ?? [])
      values[cell.column - 1] = valueOf(cell, dates, shared);
    return values;
  };
  const headers = asRow(scanned.sample[0]);
  const columns = Array.from({ length: width }, (_, i) => {
    const types = new Set(scanned.sample.slice(1).flatMap((row) => row.filter((c) => c.column === i + 1 && c.value !== "")).map((c) => typeOf(c, dates)));
    const name = headers[i];
    return { letter: columnLetter(i + 1), name: typeof name === "string" && name.trim() ? name : "", type: columnType(types) };
  });
  return { name: scanned.name, rows: scanned.rows, rows_exact: scanned.exact, columns, first_rows: scanned.sample.slice(0, examples).map(asRow) };
}
async function profileXlsx(filePath, bytes, options) {
  let entries;
  try {
    entries = await readEntries(filePath, bytes);
  } catch (error) {
    return { ok: false, reason: `the file is not a readable .xlsx: ${error instanceof Error ? error.message : String(error)}` };
  }
  const workbook = await textOf(filePath, entries.get("xl/workbook.xml"));
  if (!workbook)
    return { ok: false, reason: "the file is not a readable .xlsx: the list of sheets is missing" };
  const links = await textOf(filePath, entries.get("xl/_rels/workbook.xml.rels"));
  const targets = new Map;
  for (const m of links.matchAll(/<Relationship\s+([^>]*?)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id && target)
      targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheetList = [...workbook.matchAll(/<sheet\s+([^>]*?)\/?>/g)].flatMap((m) => {
    const name = /\bname="([^"]*)"/.exec(m[1])?.[1];
    const id = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    const entry = id ? entries.get(targets.get(id) ?? "") : undefined;
    return name && entry ? [{ name: decodeEntities(name), entry }] : [];
  });
  if (sheetList.length === 0)
    return { ok: false, reason: "the file has no sheets" };
  const deadline = Date.now() + (options.limitMs ?? DEFAULT_LIMIT_MS);
  const loaded = [];
  for (const { name, entry } of sheetList)
    loaded.push({ name, ...await scanSheet(filePath, entry, deadline) });
  const dates = dateStyles(await textOf(filePath, entries.get("xl/styles.xml")));
  const needed = new Set(loaded.flatMap((f) => f.sample.flatMap((row) => row.filter((c) => c.type === "s").map((c) => Number(c.value)))));
  const shared = await sharedStrings(filePath, entries.get("xl/sharedStrings.xml"), needed);
  const examples = options.examples ?? DEFAULT_EXAMPLES;
  return { ok: true, profile: { format: "xlsx", bytes, sheets: loaded.map((f) => sheetProfile(f, dates, shared, examples)) } };
}
function csvCells(row, separator) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0;i < row.length; i++) {
    const c = row[i];
    if (inQuotes) {
      if (c === '"' && row[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"')
        inQuotes = false;
      else
        current += c;
    } else if (c === '"')
      inQuotes = true;
    else if (c === separator) {
      cells.push(current);
      current = "";
    } else
      current += c;
  }
  cells.push(current);
  return cells;
}
function csvRows(text, max) {
  const rows = [];
  let from = 0;
  let inQuotes = false;
  for (let i = 0;i < text.length && rows.length < max; i++) {
    if (text[i] === '"')
      inQuotes = !inQuotes;
    else if (text[i] === `
` && !inQuotes) {
      rows.push(text.slice(from, text[i - 1] === "\r" ? i - 1 : i));
      from = i + 1;
    }
  }
  if (from < text.length && rows.length < max)
    rows.push(text.slice(from));
  return rows;
}
function csvCell(text) {
  const t = text.trim();
  if (t === "")
    return null;
  return /^-?\d+([.,]\d+)?$/.test(t) ? Number(t.replace(",", ".")) : shorten(text);
}
async function profileCsv(filePath, bytes, options) {
  const reader = Bun.file(filePath).stream().getReader();
  const deadline = Date.now() + (options.limitMs ?? DEFAULT_LIMIT_MS);
  const NEWLINE = 10;
  const QUOTE = 34;
  let rows = 0;
  let inQuotes = false;
  let lastByte = NEWLINE;
  const head = [];
  let collectedBytes = 0;
  let exact = true;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done)
      break;
    for (let i = 0;i < value.length; i++) {
      const b = value[i];
      if (b === QUOTE)
        inQuotes = !inQuotes;
      else if (b === NEWLINE && !inQuotes)
        rows++;
    }
    lastByte = value[value.length - 1] ?? lastByte;
    if (collectedBytes < 2000000) {
      head.push(Buffer.from(value));
      collectedBytes += value.length;
    }
    if (Date.now() > deadline) {
      exact = false;
      await reader.cancel();
      break;
    }
  }
  if (lastByte !== NEWLINE && exact)
    rows++;
  const raw = Buffer.concat(head);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(collectedBytes < bytes ? raw.subarray(0, raw.lastIndexOf(NEWLINE) + 1) : raw);
  } catch {
    text = new TextDecoder("windows-1252").decode(raw);
  }
  const textRows = csvRows(text.replace(/^\uFEFF/, ""), SAMPLE_ROWS + 1);
  const firstRow = textRows[0] ?? "";
  const separator = [";", "\t", ","].map((s) => ({ s, n: csvCells(firstRow, s).length })).sort((a, b) => b.n - a.n)[0].s;
  const sample = textRows.filter((r) => r !== "").map((r) => csvCells(r, separator).map(csvCell));
  const width = Math.max(0, ...sample.map((r) => r.length));
  const asRow = (row) => Array.from({ length: width }, (_, i) => row?.[i] ?? null);
  const headers = asRow(sample[0]);
  const columns = Array.from({ length: width }, (_, i) => {
    const types = new Set(sample.slice(1).flatMap((r) => r[i] === null || r[i] === undefined ? [] : [typeof r[i] === "number" ? "number" : "text"]));
    const name = headers[i];
    return { letter: columnLetter(i + 1), name: typeof name === "string" ? name : "", type: columnType(types) };
  });
  const examples = options.examples ?? DEFAULT_EXAMPLES;
  return { ok: true, profile: { format: "csv", bytes, sheets: [{ name: `separator ${separator === "\t" ? "tab" : separator}`, rows, rows_exact: exact, columns, first_rows: sample.slice(0, examples).map(asRow) }] } };
}
export async function tableProfile(filePath, options = {}) {
  const file = Bun.file(filePath);
  if (!await file.exists())
    return { ok: false, reason: "the file does not exist" };
  return filePath.toLowerCase().endsWith(".csv") ? profileCsv(filePath, file.size, options) : profileXlsx(filePath, file.size, options);
}
