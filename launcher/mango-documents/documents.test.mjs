// Tests of the tools: every created file is read back with a different library from the one that wrote it, and every
// edit is checked both at the touched spot and on what was NOT supposed to change.
// Run with `bun test` from the mango-documents folder (or `bun test mango-documents` from the distribution).
import { afterAll, describe, expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { DOMParser } from "@xmldom/xmldom";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { MangoDocuments } from "../opencode-home/plugin/mango-documents.js";
import { TOOLS, convert, create, edit, read } from "./mcp.mjs";
import { cellValue } from "./xlsx.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "documents-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const p = (name) => path.join(dir, name);
const zip = async (file) => JSZip.loadAsync(fs.readFileSync(file));
const xml = async (file, part) => (await zip(file)).file(part).async("string");
const exists = (file) => fs.existsSync(file);

// A real PNG (gradient), with no dependencies.
function png(w, h) {
  const crcTab = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTab[n] = c >>> 0; }
  const crc = (b) => { let r = 0xffffffff; for (const x of b) r = crcTab[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 60; raw[o + 2] = (x * 255 / w) | 0; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.writeFileSync(p("logo.png"), png(120, 60));

/** The OOXML package is consistent: every internal relationship points to a part that exists, every part has a content type. */
async function validPackage(file) {
  const z = await zip(file);
  const ct = new DOMParser().parseFromString(await z.file("[Content_Types].xml").async("string"), "text/xml");
  const over = new Set(Array.from(ct.getElementsByTagName("Override")).map((o) => o.getAttribute("PartName").slice(1)));
  const defs = new Set(Array.from(ct.getElementsByTagName("Default")).map((d) => d.getAttribute("Extension").toLowerCase()));
  const problems = [];
  const resolve = (from, t) => {
    if (t.startsWith("/")) return t.slice(1);
    const pz = from.slice(0, from.lastIndexOf("/") + 1).split("/").filter(Boolean);
    for (const s of t.split("/")) { if (s === "..") pz.pop(); else if (s !== ".") pz.push(s); }
    return pz.join("/");
  };
  for (const name of Object.keys(z.files)) {
    if (z.files[name].dir || name === "[Content_Types].xml") continue;
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (!over.has(name) && !defs.has(ext)) problems.push(`no content type: ${name}`);
    if (name.endsWith(".rels")) {
      const owner = name.replace("_rels/", "").replace(/\.rels$/, "");
      const doc = new DOMParser().parseFromString(await z.file(name).async("string"), "text/xml");
      for (const r of Array.from(doc.getElementsByTagName("Relationship"))) {
        if (r.getAttribute("TargetMode") === "External") continue;
        const t = resolve(owner, r.getAttribute("Target"));
        if (!z.file(t)) problems.push(`${name}: missing ${t}`);
      }
    }
  }
  for (const o of over) if (!z.file(o)) problems.push(`content type for a part that does not exist: ${o}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
describe("docx", () => {
  const MD = "# Report\n\nText **bold** and *italic*, accents àèìòù.\n\n## Costs\n\n- one\n  - two\n1. first\n\n| Item | Amount |\n|------|--------:|\n| Rent | 800 |\n| Power | 60 |\n\n[[page]]\n\n## End\n\nClosing.";

  test("create: headings, lists, table, header, page break; reads back with the structure", async () => {
    const out = await create({ type: "docx", file: p("r.docx"), content: MD, header: "Mango SRL" });
    expect(out).toContain("File created:");
    const doc = await xml(p("r.docx"), "word/document.xml");
    for (const t of ["Report", "bold", "àèìòù", "Rent", "800"]) expect(doc).toContain(t);
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain('w:type="page"');
    expect(await validPackage(p("r.docx"))).toEqual([]);
    const text = await read({ file: p("r.docx") });
    expect(text).toContain("# Report");
    expect(text).toContain("## Costs");
    expect(text).toContain("**bold**");
    expect(text).toContain("- one\n  - two");
    expect(text).toContain("| Rent | 800 |");
    expect(text).toContain("Header: Mango SRL");
  });

  test("replace: also on text split across several formats, without touching the rest", async () => {
    await create({ type: "docx", file: p("s.docx"), content: MD });
    const before = await zip(p("s.docx"));
    const out = await edit({ file: p("s.docx"), save_as: p("s2.docx"), operations: [{ action: "replace", find: "Text bold and", with: "Plain passage and" }, { action: "replace", find: "Power", with: "Gas\nmethane" }] });
    expect(out).toContain("File saved:");
    const after = await zip(p("s2.docx"));
    const doc = await after.file("word/document.xml").async("string");
    expect(doc).toContain("Plain passage and");
    expect(doc).not.toContain(">Power<");
    expect(doc).toContain("<w:br/>");
    expect(doc).toContain("italic"); // the format of the rest stays
    expect(doc).toContain('<w:b/>'); // the bold of the first piece stayed on the new text
    // the other parts are byte for byte identical
    for (const part of ["word/styles.xml", "word/numbering.xml", "word/footer1.xml", "[Content_Types].xml"]) {
      expect(await after.file(part).async("string")).toBe(await before.file(part).async("string"));
    }
    expect(exists(p("s.docx"))).toBe(true);
    expect(await read({ file: p("s.docx") })).toContain("Text **bold** and"); // the original is intact
  });

  test("add: numbered lists, image and link enter the file and the package stays valid", async () => {
    await create({ type: "docx", file: p("a.docx"), content: MD });
    const numBefore = ((await xml(p("a.docx"), "word/numbering.xml")).match(/<w:num /g) ?? []).length;
    await edit({
      file: p("a.docx"),
      operations: [{ action: "add", end_of_section: "Costs", markdown: "### Extra\n\n1. alpha\n2. beta\n\n![logo](logo.png)\n\n[site](https://example.com)" }],
    });
    const z = await zip(p("a.docx"));
    expect(await validPackage(p("a.docx"))).toEqual([]);
    expect(Object.keys(z.files).some((n) => /^word\/media\/.*\.png$/.test(n))).toBe(true);
    const num = await z.file("word/numbering.xml").async("string");
    expect((num.match(/<w:num /g) ?? []).length).toBeGreaterThan(numBefore);
    const text = await read({ file: p("a.docx") });
    expect(text.indexOf("### Extra")).toBeGreaterThan(text.indexOf("| Power | 60 |"));
    expect(text.indexOf("### Extra")).toBeLessThan(text.indexOf("## End"));
    expect(text).toContain("1. alpha");
    expect(text).toContain("[site](https://example.com)");
    expect(text).toContain("[image]");
    // the images have different identifiers
    const doc = await z.file("word/document.xml").async("string");
    const ids = [...doc.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("delete, delete_section, add_table_row, add at the start and after a paragraph", async () => {
    await create({ type: "docx", file: p("e.docx"), content: MD });
    await edit({
      file: p("e.docx"),
      operations: [
        { action: "add_table_row", table: 1, cells: ["Gas", "45"], after: "Power" },
        { action: "delete_section", title: "End" },
        { action: "delete", text: "Text bold" },
        { action: "add", markdown: "Before everything.", where: "start" },
        { action: "add", markdown: "After the title.", after: "Report" },
      ],
    });
    const text = await read({ file: p("e.docx") });
    expect(text).toContain("| Gas | 45 |");
    expect(text.indexOf("| Gas | 45 |")).toBeGreaterThan(text.indexOf("| Power | 60 |"));
    expect(text).not.toContain("Closing");
    expect(text).not.toContain("## End");
    expect(text).not.toContain("Text bold");
    expect(text.startsWith("Word document")).toBe(true);
    expect(text.indexOf("Before everything.")).toBeLessThan(text.indexOf("# Report"));
    expect(text.indexOf("After the title.")).toBeGreaterThan(text.indexOf("# Report"));
    expect(text).toContain("## Costs"); // the rest is there
  });

  test("errors: text not found, unknown action, no half-saved file", async () => {
    await create({ type: "docx", file: p("x.docx"), content: MD });
    const before = fs.readFileSync(p("x.docx"));
    await expect(edit({ file: p("x.docx"), operations: [{ action: "replace", find: "Power", with: "Gas" }, { action: "replace", find: "not there", with: "x" }] })).rejects.toThrow(/operation 2.*is not in the document.*Nothing was saved/);
    expect(fs.readFileSync(p("x.docx")).equals(before)).toBe(true); // the first operation was not saved
    await expect(edit({ file: p("x.docx"), operations: [{ action: "rotate" }] })).rejects.toThrow(/does not exist for a Word file/);
    await expect(edit({ file: p("x.docx"), operations: [{ action: "add_table_row", table: 1, cells: ["only one"] }] })).rejects.toThrow(/2 columns/);
    await expect(edit({ file: p("x.docx"), operations: [{ action: "add", markdown: "x", after: "nonexistent paragraph" }] })).rejects.toThrow(/no paragraph contains/);
    await expect(edit({ file: p("x.docx"), operations: "not json" })).rejects.toThrow(/list of objects/);
    await expect(create({ type: "docx", file: p("g.docx"), content: "# a\n\n| x |\n|---|\n| 1 |\n\n[[chart: bar]]" })).rejects.toThrow(/charts in Word/);
  });

  test("a file that is not Word says what is wrong", async () => {
    fs.writeFileSync(p("fake.docx"), "hello");
    await expect(read({ file: p("fake.docx") })).rejects.toThrow(/is not a real Word file/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("xlsx", () => {
  const MD = [
    "## Expenses",
    "| Item | Q1 | Q2 | Total | Date |",
    "|---|---|---|---|---|",
    "| Rent | 800 | 800 | =B2+C2 | 2026-03-01 |",
    "| Power | €60.50 | 12% | =B3+C3 | 2026-03-05 |",
    "| Total | =SUM(B2:B3) | =SUM(C2:C3) | =SUM(D2:D3) | |",
    "",
    "| Item | Q1 | Q2 |",
    "|---|---|---|",
    "| Rent | 800 | 800 |",
    "| Power | 60 | 75 |",
    "",
    "[[chart: bar | Expenses]]",
    "",
    "## Notes",
    "| Who | Weight |",
    "|---|---|",
    "| A | 40% |",
    "| B | 60% |",
    "",
    "[[chart: pie | Shares]]",
  ].join("\n");

  const load = async (f) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f); return wb; };

  test("create: sheets, real numbers, formulas with result, formats, frozen row, charts", async () => {
    const out = await create({ type: "xlsx", file: p("b.xlsx"), content: MD });
    expect(out).toContain("File created:");
    expect(await validPackage(p("b.xlsx"))).toEqual([]);
    const wb = await load(p("b.xlsx"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Expenses", "Notes"]);
    const s = wb.getWorksheet("Expenses");
    expect(s.getCell("B2").value).toBe(800);
    expect(s.getCell("D2").value.formula).toBe("B2+C2");
    expect(s.getCell("D2").value.result).toBe(1600); // result already computed
    expect(s.getCell("B4").value.result).toBeCloseTo(860.5);
    expect(s.getCell("B3").numFmt).toContain("€");
    expect(s.getCell("C3").value).toBeCloseTo(0.12);
    expect(s.getCell("C3").numFmt).toBe("0.0%");
    expect(s.getCell("E2").value).toBeInstanceOf(Date);
    expect(s.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    const z = await zip(p("b.xlsx"));
    expect(Object.keys(z.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(2);
    const chart = await z.file("xl/charts/chart1.xml").async("string");
    expect(chart).toContain("<c:barChart>");
    expect(chart).toContain("'Expenses'!$B$7:$B$8");
  });

  test("create: formula errors and numbers written the Italian way are reported, and the file stays valid", async () => {
    const out = await create({ type: "xlsx", file: p("av.xlsx"), content: "## A\n| x | y |\n|---|---|\n| 1.250,50 | =1/0 |\n| 2 | =FOO(1) |" });
    expect(out).toContain("WARNING");
    expect(out).toContain("1250.50");
    expect(out).toContain("#DIV/0!");
    expect(out).toContain("#NAME?");
    const wb = await load(p("av.xlsx"));
    expect(wb.getWorksheet("A").getCell("B3").value.result).toEqual({ error: "#NAME?" }); // a code that Excel accepts
  });

  test("read: formulas and results, range, used area", async () => {
    const t = await read({ file: p("b.xlsx") });
    expect(t).toContain("=B2+C2 → 1600");
    expect(t).toContain("(with charts)");
    expect(t).toContain("| row | A | B |");
    const part = await read({ file: p("b.xlsx"), part: "Expenses!A2:B3" });
    expect(part).toContain("Rent");
    expect(part).not.toContain("Sheet «Notes»");
    await expect(read({ file: p("b.xlsx"), part: "Nonexistent" })).rejects.toThrow(/does not exist.*Expenses/);
  });

  test("edit: keeps formulas, formats and charts; recalculates; adds rows, column, sheet and chart", async () => {
    await create({ type: "xlsx", file: p("m.xlsx"), content: MD });
    const out = await edit({
      file: p("m.xlsx"),
      operations: [
        { action: "set", sheet: "Expenses", cell: "B2", values: 900 },
        { action: "add_rows", sheet: "Expenses", rows: [["Gas", 40, 55, "=B{r}+C{r}", "2026-04-01"]] },
        { action: "add_column", sheet: "Expenses", header: "Average", values: "=AVERAGE(B{r}:C{r})", rows: "2-3", format: "number" },
        { action: "add_sheet", name: "Summary", markdown: "| Item | Value |\n|---|---|\n| Tot | =SUM(Expenses!D2:D3) |\n| Other | 5 |\n\n[[chart: line]]" },
        { action: "chart", sheet: "Expenses", range: "A6:C8", type: "horizontal", title: "Q", position: "H20" },
        { action: "format", sheet: "Expenses", range: "A1:F1", fill: "yellow", bold: true },
      ],
    });
    expect(out).toContain("File modified:");
    expect(await validPackage(p("m.xlsx"))).toEqual([]);
    const wb = await load(p("m.xlsx"));
    const s = wb.getWorksheet("Expenses");
    expect(s.getCell("B2").value).toBe(900);
    expect(s.getCell("D2").value.formula).toBe("B2+C2");
    expect(s.getCell("D2").value.result).toBe(1700); // recalculated with the new number
    expect(s.getCell("B4").value.formula).toBe("SUM(B2:B3)"); // total formula intact
    expect(s.getCell("B3").numFmt).toContain("€"); // format intact
    expect(s.getCell("C3").numFmt).toBe("0.0%");
    expect(s.getCell("A9").value).toBe("Gas"); // row added below the last used one (the 8th)
    expect(s.getCell("D9").value.result).toBe(95);
    expect(s.getCell("F2").value.formula).toBe("AVERAGE(B2:C2)");
    expect(s.getCell("F2").numFmt).toBe("#,##0.00");
    expect(wb.getWorksheet("Summary").getCell("B2").value.result).toBeCloseTo(1700 + 60.62);
    // REGRESSION: the styles of cells read from a file are shared; formatting A1:F1 must not color the other headers
    const otherHeader = wb.getWorksheet("Notes").getCell("A1");
    expect(otherHeader.fill.fgColor.argb).toBe("FF1F4E79");
    expect(s.getCell("A1").fill.fgColor.argb).toBe("FFFFFF00");
    expect(s.getCell("A6").fill.fgColor.argb).toBe("FF1F4E79");
    // charts: the 2 original ones, 1 in the new sheet, 1 added
    const z = await zip(p("m.xlsx"));
    expect(Object.keys(z.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(4);
    expect(await read({ file: p("m.xlsx") })).toContain("(with charts)");
  });

  test("add_rows below the header alone does not inherit the header color", async () => {
    await create({ type: "xlsx", file: p("h.xlsx"), content: "## S\n| a | b |\n|---|---|\n" });
    await edit({ file: p("h.xlsx"), operations: [{ action: "add_rows", rows: [[1, 2]] }] });
    const wb = await load(p("h.xlsx"));
    expect(wb.getWorksheet("S").getCell("A2").fill?.fgColor?.argb).toBeUndefined();
    expect(wb.getWorksheet("S").getCell("A2").value).toBe(1);
  });

  test("edit: clear errors, nothing saved halfway", async () => {
    await create({ type: "xlsx", file: p("e.xlsx"), content: MD });
    const before = fs.readFileSync(p("e.xlsx"));
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "set", cell: "A1", values: 1 }] })).rejects.toThrow(/name the sheet.*Expenses.*Notes/);
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "set", sheet: "Expenses", cell: "Z", values: 1 }] })).rejects.toThrow(/is not a cell/);
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "set", sheet: "Expenses", cell: "A9", values: 1 }, { action: "format", sheet: "Expenses", range: "A1", fill: "fuchsia" }] })).rejects.toThrow(/operation 2.*is not a color/);
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "add_column", sheet: "Expenses", header: "x", values: [1] }] })).rejects.toThrow(/elements but rows/);
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "delete_rows" }] })).rejects.toThrow(/does not exist for an Excel file/);
    await expect(edit({ file: p("e.xlsx"), operations: [{ action: "chart", sheet: "Expenses", range: "A1:E3", type: "bar" }] })).rejects.toThrow(/contains no numbers/);
    expect(fs.readFileSync(p("e.xlsx")).equals(before)).toBe(true);
  });

  test("cellValue: only what is really a number becomes a number", () => {
    expect(cellValue("1250.5").value).toBe(1250.5);
    expect(cellValue("-3").value).toBe(-3);
    expect(cellValue("007").value).toBe("007");
    expect(cellValue("1.250,50").value).toBe("1.250,50");
    expect(cellValue("1.250,50").warning).toContain("1250.50");
    expect(cellValue("€12.5").format).toContain("€");
    expect(cellValue("12.5 €").value).toBe(12.5);
    expect(cellValue("2026-02-30").value).toBe("2026-02-30");
    expect(cellValue("=SUM(A1:A3)").value).toEqual({ formula: "SUM(A1:A3)" });
  });
});

// ---------------------------------------------------------------------------------------------
describe("pptx", () => {
  const MD = "# Plan\nFor the board\n\n# Goals\n- **Grow** by 15%\n- Open two offices\n> Say they are estimates\n\n# Data\n| Qtr | Revenue | Costs |\n|---|--:|--:|\n| Q1 | 1200 | 800 |\n| Q2 | 1500 | 900 |\n\n[[chart: bar | Revenue and costs]]";

  test("create: real titles, speaker notes, native chart; reads back", async () => {
    await create({ type: "pptx", file: p("s.pptx"), content: MD });
    expect(await validPackage(p("s.pptx"))).toEqual([]);
    const z = await zip(p("s.pptx"));
    expect(Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(3);
    expect(await z.file("ppt/slides/slide2.xml").async("string")).toContain('type="title"'); // the title is a real placeholder
    expect(Object.keys(z.files).some((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))).toBe(true);
    const t = await read({ file: p("s.pptx") });
    expect(t).toContain("## Slide 1 — Plan");
    expect(t).toContain("## Slide 2 — Goals");
    expect(t).toContain("- Open two offices");
    expect(t).toContain("Speaker notes: Say they are estimates");
    expect(t).toContain("[chart]");
    expect(await read({ file: p("s.pptx"), part: "2" })).not.toContain("Slide 1");
    await expect(read({ file: p("s.pptx"), part: "9" })).rejects.toThrow(/outside the document/);
  });

  /** Adds a list of sections to the file (as PowerPoint does) to check that edits and sections stay in agreement. */
  async function withSections(file) {
    const z = await zip(file);
    let pres = await z.file("ppt/presentation.xml").async("string");
    const ids = [...pres.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => m[1]);
    const sec = (name, g, list) => `<p14:section name="${name}" id="{${g}}"><p14:sldIdLst>${list.map((i) => `<p14:sldId id="${i}"/>`).join("")}</p14:sldIdLst></p14:section>`;
    const ext = `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${sec("One", "11111111-1111-1111-1111-111111111111", ids.slice(0, 1))}${sec("Two", "22222222-2222-2222-2222-222222222222", ids.slice(1))}</p14:sectionLst></p:ext></p:extLst>`;
    pres = pres.replace("</p:presentation>", `${ext}</p:presentation>`);
    z.file("ppt/presentation.xml", pres);
    fs.writeFileSync(file, await z.generateAsync({ type: "nodebuffer" }));
  }
  const sectionsOk = async (file) => {
    const pres = await xml(file, "ppt/presentation.xml");
    const order = [...pres.match(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/)[0].matchAll(/id="(\d+)"/g)].map((m) => m[1]);
    const inSections = [...pres.match(/<p14:sectionLst[\s\S]*?<\/p14:sectionLst>/)[0].matchAll(/<p14:sldId id="(\d+)"/g)].map((m) => m[1]);
    return { order, inSections };
  };

  test("edit: add, move, delete slides and replace; the other slides and the sections stay valid", async () => {
    await create({ type: "pptx", file: p("m.pptx"), content: MD });
    await withSections(p("m.pptx"));
    const slide2Before = await xml(p("m.pptx"), "ppt/slides/slide2.xml");
    const out = await edit({
      file: p("m.pptx"),
      operations: [
        { action: "add_slide", after: 1, markdown: "# Risks\n- Market\n- Costs\n> Discuss it\n\n# Shares\n| T | V |\n|---|--:|\n| A | 1 |\n| B | 3 |\n\n[[chart: pie]]" },
      ],
    });
    expect(out).toContain("added 2 slides");
    expect(await validPackage(p("m.pptx"))).toEqual([]);
    let t = await read({ file: p("m.pptx") });
    expect(t).toContain("5 slides");
    expect(t.indexOf("— Risks")).toBeGreaterThan(t.indexOf("— Plan"));
    expect(t.indexOf("— Risks")).toBeLessThan(t.indexOf("— Goals"));
    expect(t).toContain("Speaker notes: Discuss it");
    expect((await sectionsOk(p("m.pptx"))).inSections.sort()).toEqual((await sectionsOk(p("m.pptx"))).order.sort());
    expect(await xml(p("m.pptx"), "ppt/slides/slide2.xml")).toBe(slide2Before); // an untouched slide is identical
    // in a file made by us the new slides reuse the layout of the others (title, rule, page number)
    const layoutOf = async (n) => (await xml(p("m.pptx"), `ppt/slides/_rels/slide${n}.xml.rels`)).match(/slideLayouts\/(slideLayout\d+\.xml)/)[1];
    expect(await layoutOf(4)).toBe(await layoutOf(2));

    await edit({ file: p("m.pptx"), operations: [{ action: "move_slide", slide: 5, to: 1 }, { action: "delete_slide", slide: 3 }, { action: "replace", find: "Grow", with: "Increase" }] });
    expect(await validPackage(p("m.pptx"))).toEqual([]);
    t = await read({ file: p("m.pptx") });
    expect(t).toContain("4 slides");
    expect(t).toContain("Increase by 15%");
    expect(t).not.toContain("Risks");
    expect(t.indexOf("— Data")).toBeGreaterThan(0);
    const s = await sectionsOk(p("m.pptx"));
    expect(s.inSections.sort()).toEqual(s.order.sort()); // no orphan ids, no slide outside the sections
    // the deleted slide and its notes are no longer in the package
    const z = await zip(p("m.pptx"));
    expect(Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(4);
  });

  test("edit: clear errors", async () => {
    await create({ type: "pptx", file: p("e.pptx"), content: MD });
    const before = fs.readFileSync(p("e.pptx"));
    await expect(edit({ file: p("e.pptx"), operations: [{ action: "delete_slide", slide: 9 }] })).rejects.toThrow(/slide 9 does not exist.*3/);
    await expect(edit({ file: p("e.pptx"), operations: [{ action: "replace", find: "xyz", with: "a" }] })).rejects.toThrow(/is not in any slide/);
    await expect(edit({ file: p("e.pptx"), operations: [{ action: "add_slide", markdown: "# a\n\n| x | y |\n|---|---|\n| a | b |\n\n[[chart: bar]]" }] })).rejects.toThrow(/needs numbers/);
    expect(fs.readFileSync(p("e.pptx")).equals(before)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("pdf", () => {
  const MD = "# Contract\n\nCaffè, perché, più, già: àèìòù. Price 1.250,50 €.\n\n[[page]]\n\n## Second\n\n| Item | Amount |\n|---|--:|\n| Rent | 800 |\n\n[[page]]\n\n## Third\n\nEnd.";

  test("create: correct accents, header, pages; reads back", async () => {
    await create({ type: "pdf", file: p("c.pdf"), content: MD, header: "Mango SRL" });
    const data = fs.readFileSync(p("c.pdf"));
    expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    const t = await read({ file: p("c.pdf") });
    expect(t).toContain("3 pages");
    expect(t).toContain("Caffè, perché, più, già: àèìòù. Price 1.250,50 €.");
    expect(t).toContain("Mango SRL");
    expect(t).toContain("Rent  800"); // columns separated by two spaces
    expect(await read({ file: p("c.pdf"), part: "3" })).not.toContain("Contract");
  });

  test("edit: merge, reorder, rotate, delete, extract, watermark, page numbers", async () => {
    await create({ type: "pdf", file: p("pa.pdf"), content: MD });
    await create({ type: "pdf", file: p("pb.pdf"), content: "# Attachment\n\nAttachment text." });
    await edit({ file: p("pa.pdf"), save_as: p("pm.pdf"), operations: [{ action: "merge", other_files: [p("pb.pdf")] }, { action: "watermark", text: "DRAFT", pages: "1-2" }, { action: "number_pages" }, { action: "rotate", degrees: 90, pages: "2" }, { action: "reorder", order: "4,1,2,3" }] });
    const doc = await PDFDocument.load(fs.readFileSync(p("pm.pdf")));
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getPage(2).getRotation().angle).toBe(90); // the original page 2 is now the third
    expect(doc.getPage(0).getRotation().angle).toBe(0);
    const text = await read({ file: p("pm.pdf") });
    expect(text.indexOf("Attachment")).toBeLessThan(text.indexOf("Contract"));
    expect(text).toContain("1 / 4");
    expect(await PDFDocument.load(fs.readFileSync(p("pa.pdf"))).then((d) => d.getPageCount())).toBe(3); // the original is intact

    await edit({ file: p("pm.pdf"), save_as: p("pe.pdf"), operations: [{ action: "delete_pages", pages: "1" }, { action: "extract_pages", pages: "2-3" }] });
    expect(await PDFDocument.load(fs.readFileSync(p("pe.pdf"))).then((d) => d.getPageCount())).toBe(2);
    const q = await edit({ file: p("pa.pdf"), save_as: p("pd.pdf"), operations: [{ action: "split", every: 2 }] });
    expect(q).toContain("pd_part1.pdf");
    expect(exists(p("pd_part1.pdf")) && exists(p("pd_part2.pdf"))).toBe(true);
    expect(await PDFDocument.load(fs.readFileSync(p("pd_part2.pdf"))).then((d) => d.getPageCount())).toBe(1);
  });

  test("PDF form: the fields are read and filled", async () => {
    const d = await PDFDocument.create();
    const pg = d.addPage([400, 300]);
    const f = d.getForm();
    f.createTextField("name").addToPage(pg, { x: 50, y: 200, width: 200, height: 20 });
    f.createCheckBox("accept").addToPage(pg, { x: 50, y: 150, width: 15, height: 15 });
    const dd = f.createDropdown("city"); dd.addOptions(["Rome", "Milan"]); dd.addToPage(pg, { x: 50, y: 100, width: 100, height: 20 });
    fs.writeFileSync(p("form.pdf"), await d.save());
    const t = await read({ file: p("form.pdf") });
    expect(t).toContain("«name» (text)");
    expect(t).toContain("«city» (choice among: «Rome», «Milan»)");
    expect(t).not.toContain("scan"); // a page without text but with fields is not a scan
    await edit({ file: p("form.pdf"), save_as: p("form2.pdf"), operations: [{ action: "fill_form", fields: { name: "Mario è già qui", accept: "true", city: "Milan" } }] });
    const form = (await PDFDocument.load(fs.readFileSync(p("form2.pdf")))).getForm();
    expect(form.getTextField("name").getText()).toBe("Mario è già qui");
    expect(form.getCheckBox("accept").isChecked()).toBe(true);
    expect(form.getDropdown("city").getSelected()).toEqual(["Milan"]);
    await expect(edit({ file: p("form.pdf"), operations: [{ action: "fill_form", fields: { surname: "x" } }] })).rejects.toThrow(/field «surname» does not exist.*«name»/);
    await expect(edit({ file: p("form.pdf"), operations: [{ action: "fill_form", fields: { city: "Naples" } }] })).rejects.toThrow(/is not among the possible items/);
  });

  test("a page without text is declared a scan, never invented content", async () => {
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    fs.writeFileSync(p("blank.pdf"), await d.save());
    expect(await read({ file: p("blank.pdf") })).toContain("scan");
  });

  test("errors: pages outside the file, deleting everything, wrong degrees", async () => {
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "delete_pages", pages: "1-3" }] })).rejects.toThrow(/all the pages/);
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "rotate", degrees: 45 }] })).rejects.toThrow(/90, 180 or 270/);
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "extract_pages", pages: "7" }] })).rejects.toThrow(/outside the document.*3/);
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "reorder", order: "1,2" }] })).rejects.toThrow(/all 3 pages/);
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "watermark", text: "漢字" }] })).rejects.toThrow(/cannot write/);
    await expect(edit({ file: p("pa.pdf"), operations: [{ action: "merge", other_files: [p("missing.pdf")] }] })).rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("convert", () => {
  test("docx -> pdf (simplified) keeps text, tables and images", async () => {
    await create({ type: "docx", file: p("cd.docx"), content: "# Minutes\n\nText with *italic* and 2 * 3 and _not italic_.\n\n![logo](logo.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |" });
    const out = await convert({ file: p("cd.docx"), format: "pdf" });
    expect(out).toContain("simplified version");
    const t = await read({ file: p("cd.pdf") });
    expect(t).toContain("Minutes");
    expect(t).toContain("1  2");
    const doc = await PDFDocument.load(fs.readFileSync(p("cd.pdf")));
    expect(doc.getPageCount()).toBe(1);
    expect(fs.readFileSync(p("cd.pdf")).includes(Buffer.from("/Subtype /Image"))).toBe(true);
  });

  test("xlsx -> csv and csv -> xlsx: numbers, dates and text with quotes", async () => {
    await create({ type: "xlsx", file: p("cv.xlsx"), content: "## Data\n| Item | Amount | Date |\n|---|---|---|\n| Pens, blue | 12.5 | 2026-03-01 |\n| Sheet \"A4\" | =B2*2 | 2026-03-02 |" });
    const out = await convert({ file: p("cv.xlsx"), format: "csv" });
    expect(out).toContain("separator «;»");
    const csv = fs.readFileSync(p("cv.csv"), "utf8");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Pens, blue;12,5;2026-03-01'); // the comma is not the separator: no quotes
    expect(csv).toContain('"Sheet ""A4""";25;2026-03-02');
    await convert({ file: p("cv.csv"), format: "xlsx", save_as: p("cv2.xlsx") });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p("cv2.xlsx"));
    const ws = wb.worksheets[0];
    expect(ws.getCell("A2").value).toBe("Pens, blue");
    expect(ws.getCell("B2").value).toBe(12.5);
    expect(ws.getCell("C2").value).toBeInstanceOf(Date);
    const pdfX = await convert({ file: p("cv.xlsx"), format: "pdf" });
    expect(pdfX).toContain("simplified version");
    expect(await read({ file: p("cv.pdf") })).toContain("12,5");
  });

  test("conversions without an honest result are refused, saying why", async () => {
    await create({ type: "pptx", file: p("np.pptx"), content: "# A\n- b" });
    await expect(convert({ file: p("np.pptx"), format: "pdf" })).rejects.toThrow(/not possible.*PowerPoint/);
    await expect(convert({ file: p("c.pdf"), format: "xlsx" })).rejects.toThrow(/not possible/);
    await expect(convert({ file: p("cd.docx"), format: "csv" })).rejects.toThrow(/not supported/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("calls and protocol", () => {
  test("incomplete path, unknown type, empty content, missing image", async () => {
    await expect(create({ type: "docx", file: "relative.docx", content: "# x" })).rejects.toThrow(/is not a full path/);
    await expect(create({ type: "odt", file: p("a.odt"), content: "# x" })).rejects.toThrow(/unknown type «odt»/);
    await expect(create({ type: "docx", file: p("a.docx"), content: "  " })).rejects.toThrow(/content is empty/);
    await expect(create({ type: "xlsx", file: p("v.xlsx"), content: "## only a title" })).rejects.toThrow(/at least one Markdown table/);
    await expect(create({ type: "docx", file: p("e.docx"), content: "# x", style: "fuchsia" })).rejects.toThrow(/unknown style «fuchsia»/);
    await expect(create({ type: "docx", file: p("half.docx"), content: "![x](not-there.png)" })).rejects.toThrow(/image not found/);
    expect(exists(p("half.docx"))).toBe(false); // an error leaves no half-written file
    await expect(create({ type: "pdf", file: p("e.pdf"), content: "![x](https://example.com/a.png)" })).rejects.toThrow(/download it into the project first/);
    await expect(create({ type: "pdf", file: p("e.pdf"), content: "x", header: "hello" }).then(() => create({ type: "xlsx", file: p("i.xlsx"), content: "| a |\n|---|\n| 1 |", header: "no" }))).rejects.toThrow(/only used for docx and pdf/);
    await expect(read({ file: p("does-not-exist.docx") })).rejects.toThrow(/does not exist/);
    await expect(read({ file: p("logo.png") })).rejects.toThrow(/unsupported format.*\.doc/);
  });

  test("the MCP server lists the four tools and answers calls", async () => {
    const proc = Bun.spawn(["bun", path.join(import.meta.dir, "mcp.mjs")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { file: p("c.pdf") } } })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "edit", arguments: { file: p("c.pdf"), operations: [{ action: "huh" }] } } })}\n`);
    proc.stdin.flush();
    const lines = [];
    const reader = proc.stdout.getReader();
    let buf = "";
    while (lines.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    }
    proc.kill();
    const byId = (id) => lines.find((r) => r.id === id).result;
    expect(byId(1).tools.map((t) => t.name)).toEqual(["create", "read", "edit", "convert"]);
    expect(byId(2).content[0].text).toContain("3 pages");
    expect(byId(3).isError).toBe(true);
    expect(byId(3).content[0].text).toStartWith("ERROR:");
    expect(TOOLS.every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  test("the plugin completes plain file names with the session folder", async () => {
    const plugin = await MangoDocuments({ directory: dir });
    const out = { args: { file: "a.docx", save_as: "b.docx", operations: [{ action: "merge", other_files: ["x.pdf", p("y.pdf")] }] } };
    await plugin["tool.execute.before"]({ tool: "documents_edit" }, out);
    expect(out.args.file).toBe(path.join(dir, "a.docx"));
    expect(out.args.save_as).toBe(path.join(dir, "b.docx"));
    expect(out.args.operations[0].other_files).toEqual([path.join(dir, "x.pdf"), p("y.pdf")]);
    const other = { args: { file: "a.docx" } };
    await plugin["tool.execute.before"]({ tool: "bash" }, other);
    expect(other.args.file).toBe("a.docx");
  });
});
