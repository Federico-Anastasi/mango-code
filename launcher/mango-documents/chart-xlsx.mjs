// Native Excel charts. `exceljs` cannot write them, so we work on the .xlsx package (a zip of XML):
// the sheet drawing, the chart and the references are added. The chart points to the cells (it updates
// if the numbers change) and carries a copy of the values for whoever does not recalculate.
import JSZip from "jszip";
import { parseXml, escapeXml, childrenOf, serializeXml } from "./common.mjs";
import {
  NS_REL, REL, addOverride, copyPart, emptyRels, readXml, addRel, freePart, relativeTarget, relsOf, resolveTarget, baseName,
} from "./ooxml.mjs";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const TYPE_DRAWING = REL("drawing");
const TYPE_CHART = REL("chart");
const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const COLORS = ["1F4E79", "ED7D31", "70AD47", "FFC000", "5B9BD5", "A5A5A5", "7030A0", "C00000"];

const absolute = (ref) => ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2");
const sheetRef = (sheet, ref) => `'${sheet.replace(/'/g, "''")}'!${absolute(ref)}`;

function textCache(values) {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
}
function numberCache(values) {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`;
}
const fill = (color) => `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
const line = (color) => `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`;

/** XML of the `xl/charts/chartN.xml` part. */
export function chartXml(g) {
  const colors = [g.color, ...COLORS.filter((c) => c !== g.color)];
  const cat = `<c:cat><c:strRef><c:f>${escapeXml(sheetRef(g.sheet, g.categoriesRef))}</c:f>${textCache(g.categories)}</c:strRef></c:cat>`;
  const series = g.series.map((s, i) => {
    const name = `<c:tx><c:strRef><c:f>${escapeXml(sheetRef(g.sheet, s.nameRef))}</c:f>${textCache([s.name])}</c:strRef></c:tx>`;
    const val = `<c:val><c:numRef><c:f>${escapeXml(sheetRef(g.sheet, s.valuesRef))}</c:f>${numberCache(s.values)}</c:numRef></c:val>`;
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${name}`;
    if (g.type === "line") {
      return `<c:ser>${head}${line(colors[i % colors.length])}<c:marker><c:symbol val="circle"/><c:size val="6"/>${fill(colors[i % colors.length])}</c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
    }
    if (g.type === "pie") {
      const points = g.categories.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/>${fill(colors[k % colors.length])}</c:dPt>`).join("");
      return `<c:ser>${head}${points}<c:dLbls><c:numFmt formatCode="0%" sourceLinked="0"/><c:spPr><a:noFill/></c:spPr><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>${cat}${val}</c:ser>`;
    }
    return `<c:ser>${head}${fill(colors[i % colors.length])}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
  }).join("");

  const AXES = `<c:axId val="50010"/><c:axId val="50020"/>`;
  const catAxis = (pos) => `<c:catAx><c:axId val="50010"/><c:scaling><c:orientation val="${pos === "l" ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50020"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const valAxis = (pos) => `<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;

  let area;
  if (g.type === "bar") area = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/>${AXES}</c:barChart>${catAxis("b")}${valAxis("l")}`;
  else if (g.type === "horizontal") area = `<c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/>${AXES}</c:barChart>${catAxis("l")}${valAxis("b")}`;
  else if (g.type === "line") area = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${AXES}</c:lineChart>${catAxis("b")}${valAxis("l")}`;
  else area = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;

  const title = g.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1400" b="1"/></a:pPr><a:r><a:rPr lang="it-IT" sz="1400" b="1"/><a:t>${escapeXml(g.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;
  const legend = g.series.length > 1 || g.type === "pie" ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${area}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function anchorXml(column, row, rId, shapeId, name) {
  return `<xdr:oneCellAnchor xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="5400000" cy="3240000"/><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${shapeId}" name="${escapeXml(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${NS_REL}" r:id="${rId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`;
}

// --- the .xlsx package -------------------------------------------------------------------

/** Path of the part of the sheet `name`. */
async function findSheet(zip, name) {
  const wb = await readXml(zip, "xl/workbook.xml");
  const rels = await readXml(zip, "xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw new Error("the Excel file does not have the expected structure");
  const sheets = Array.from(wb.getElementsByTagName("sheet"));
  const el = sheets.find((x) => x.getAttribute("name") === name);
  if (!el) throw new Error(`the sheet «${name}» does not exist`);
  const rId = el.getAttributeNS(NS_REL, "id") || el.getAttribute("r:id");
  const rel = childrenOf(rels.documentElement, "Relationship").find((r) => r.getAttribute("Id") === rId);
  return resolveTarget("xl/workbook.xml", rel.getAttribute("Target"));
}

/**
 * The drawing of a sheet (created if missing). Returns an object with `addPart`, `addExistingAnchor`,
 * `newChartRel` and `save()`.
 */
async function sheetDrawing(zip, ct, sheetName) {
  const sheetPart = await findSheet(zip, sheetName);
  const relsPath = relsOf(sheetPart);
  const sheetRels = (await readXml(zip, relsPath)) ?? emptyRels();
  const sheet = parseXml(await zip.file(sheetPart).async("string"));

  const drawingRel = childrenOf(sheetRels.documentElement, "Relationship").find((r) => r.getAttribute("Type") === TYPE_DRAWING);
  let drawingPart, drawing, drawingRels;
  if (drawingRel) {
    drawingPart = resolveTarget(sheetPart, drawingRel.getAttribute("Target"));
    drawing = await readXml(zip, drawingPart);
    drawingRels = (await readXml(zip, relsOf(drawingPart))) ?? emptyRels();
  } else {
    drawingPart = freePart(zip, "xl/drawings/drawing#.xml");
    drawing = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`);
    drawingRels = emptyRels();
    const id = addRel(sheetRels, TYPE_DRAWING, relativeTarget(sheetPart, drawingPart));
    addOverride(ct, drawingPart, CT_DRAWING);
    const el = sheet.createElementNS(NS_MAIN, "drawing");
    el.setAttributeNS(NS_REL, "r:id", id);
    const after = ["legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];
    const before = childrenOf(sheet.documentElement).find((n) => after.includes(n.localName ?? n.nodeName));
    sheet.documentElement.insertBefore(el, before ?? null);
  }

  return {
    drawingPart,
    /** Adds an anchor with a ready `xl/charts/` part. */
    addPart(chartPart, column, row, name) {
      const rId = addRel(drawingRels, TYPE_CHART, relativeTarget(drawingPart, chartPart));
      const ids = Array.from(drawing.getElementsByTagName("xdr:cNvPr")).map((e) => Number(e.getAttribute("id")) || 0);
      const frag = parseXml(anchorXml(column, row, rId, Math.max(1, ...ids) + 1, name));
      drawing.documentElement.appendChild(drawing.importNode(frag.documentElement, true));
    },
    addExistingAnchor(anchor, newRId) {
      const copy = drawing.importNode(anchor, true);
      for (const c of Array.from(copy.getElementsByTagName("c:chart"))) c.setAttributeNS(NS_REL, "r:id", newRId);
      const ids = Array.from(drawing.getElementsByTagName("xdr:cNvPr")).map((e) => Number(e.getAttribute("id")) || 0);
      for (const p of Array.from(copy.getElementsByTagName("xdr:cNvPr"))) p.setAttribute("id", String(Math.max(1, ...ids) + 1));
      drawing.documentElement.appendChild(copy);
    },
    newChartRel: (chartPart) => addRel(drawingRels, TYPE_CHART, relativeTarget(drawingPart, chartPart)),
    save() {
      zip.file(sheetPart, serializeXml(sheet));
      zip.file(relsPath, serializeXml(sheetRels));
      zip.file(drawingPart, serializeXml(drawing));
      zip.file(relsOf(drawingPart), serializeXml(drawingRels));
    },
  };
}

/** Adds charts (see `chartFromTable` in xlsx.mjs) to an already written .xlsx. Returns the new package. */
export async function injectCharts(buffer, charts) {
  const zip = await JSZip.loadAsync(buffer);
  const ct = parseXml(await zip.file("[Content_Types].xml").async("string"));
  const bySheet = new Map();
  for (const g of charts) bySheet.set(g.sheet, [...(bySheet.get(g.sheet) ?? []), g]);
  for (const [name, list] of bySheet) {
    const drawing = await sheetDrawing(zip, ct, name);
    for (const g of list) {
      const part = freePart(zip, "xl/charts/chart#.xml");
      zip.file(part, chartXml(g));
      addOverride(ct, part, CT_CHART);
      drawing.addPart(part, g.anchor.column, g.anchor.row, `Chart ${baseName(part).replace(/\D/g, "")}`);
    }
    drawing.save();
  }
  zip.file("[Content_Types].xml", serializeXml(ct));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/**
 * All the charts present in an .xlsx: needed to know whether an edit done with `exceljs` (which does not
 * know them and would delete them) must get them back. Returns the names of the sheets that have any.
 */
export async function sheetsWithCharts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const out = [];
  const wb = await readXml(zip, "xl/workbook.xml");
  if (!wb) return out;
  for (const f of Array.from(wb.getElementsByTagName("sheet"))) {
    const name = f.getAttribute("name");
    const sheetPart = await findSheet(zip, name);
    const rels = await readXml(zip, relsOf(sheetPart));
    const rd = rels && childrenOf(rels.documentElement, "Relationship").find((r) => r.getAttribute("Type") === TYPE_DRAWING);
    if (!rd) continue;
    const drawingPart = resolveTarget(sheetPart, rd.getAttribute("Target"));
    const drawingRels = await readXml(zip, relsOf(drawingPart));
    if (drawingRels && childrenOf(drawingRels.documentElement, "Relationship").some((r) => r.getAttribute("Type") === TYPE_CHART)) out.push(name);
  }
  return out;
}

/** Elements that `exceljs` does not keep and that an edit would ruin: pivot tables, macros, slicers. */
export async function unpreservableParts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  const found = [];
  if (names.some((n) => n.startsWith("xl/pivotTables/") || n.startsWith("xl/pivotCache/"))) found.push("pivot tables");
  if (names.some((n) => n === "xl/vbaProject.bin")) found.push("macros");
  if (names.some((n) => n.startsWith("xl/slicers/"))) found.push("slicers");
  return found;
}

/**
 * Puts back into `updated` the charts that `original` had and `exceljs` lost. The charts are copied with
 * their linked parts (styles, colors); the anchors stay where they were.
 */
export async function restoreCharts(original, updated) {
  const O = await JSZip.loadAsync(original);
  const N = await JSZip.loadAsync(updated);
  const ctO = parseXml(await O.file("[Content_Types].xml").async("string"));
  const ctN = parseXml(await N.file("[Content_Types].xml").async("string"));
  const wb = await readXml(O, "xl/workbook.xml");
  let done = 0;
  const map = new Map();

  for (const f of Array.from(wb.getElementsByTagName("sheet"))) {
    const name = f.getAttribute("name");
    const sheetPart = await findSheet(O, name);
    const rels = await readXml(O, relsOf(sheetPart));
    const rd = rels && childrenOf(rels.documentElement, "Relationship").find((r) => r.getAttribute("Type") === TYPE_DRAWING);
    if (!rd) continue;
    const drawingPart = resolveTarget(sheetPart, rd.getAttribute("Target"));
    const drawing = await readXml(O, drawingPart);
    const drawingRels = await readXml(O, relsOf(drawingPart));
    if (!drawing || !drawingRels) continue;

    const anchors = childrenOf(drawing.documentElement).filter((a) => a.getElementsByTagName("c:chart").length > 0);
    if (!anchors.length) continue;
    const dr = await sheetDrawing(N, ctN, name);

    for (const anchor of anchors) {
      const oldRId = anchor.getElementsByTagName("c:chart")[0].getAttributeNS(NS_REL, "id") || anchor.getElementsByTagName("c:chart")[0].getAttribute("r:id");
      const rel = childrenOf(drawingRels.documentElement, "Relationship").find((r) => r.getAttribute("Id") === oldRId);
      if (!rel) continue;
      const partO = resolveTarget(drawingPart, rel.getAttribute("Target"));
      // The chart is copied with the parts it points to (style, colors, embedded workbook).
      const partN = await copyPart(O, N, ctO, ctN, partO, { map });
      const newRId = dr.newChartRel(partN);
      dr.addExistingAnchor(anchor, newRId);
      done++;
    }
    dr.save();
  }
  if (!done) return updated;
  N.file("[Content_Types].xml", serializeXml(ctN));
  return N.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Zero-based column and zero-based row from an address like «G2». */
export function anchorFrom(cell) {
  const m = String(cell).trim().match(/^([A-Za-z]{1,3})(\d{1,7})$/);
  if (!m) throw new Error(`«${cell}» is not a cell: write for example G2`);
  let n = 0;
  for (const c of m[1].toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return { column: n - 1, row: Number(m[2]) - 1 };
}
