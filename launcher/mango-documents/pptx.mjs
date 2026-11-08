// Markdown -> PowerPoint (.pptx) with `pptxgenjs`.
//
// One slide for each `# Title` (or each `---` line). Inside: paragraphs, lists, tables, images;
// quotes (`> ...`) become the speaker notes. If the first slide has only a title and text, it is the cover.
import pptxgen from "pptxgenjs";
import JSZip from "jszip";
import { parseXml, blocks, childrenOf, directive, imagesOf, plainText, readImage, resolveStyle, segments, serializeXml, chartType } from "./common.mjs";

const SLIDE_W = 13.333, SLIDE_H = 7.5; // inches (16:9)
const MARGIN = 0.6;
const BODY = { x: MARGIN, y: 1.55, w: SLIDE_W - 2 * MARGIN, h: SLIDE_H - 1.55 - 0.7 };

function newSlide(title) { return { title, elements: [], notes: [] }; }

function groupSlides(toks) {
  const slides = [];
  let cur = null;
  const open = (title) => { cur = newSlide(title); slides.push(cur); };
  for (const t of toks) {
    if (t.type === "heading" && t.depth === 1) { open(plainText(t.tokens)); continue; }
    if (t.type === "hr") { open(""); continue; }
    const dv = directive(t);
    if (dv?.name === "page") { open(""); continue; }
    if (!cur) open("");
    if (dv?.name === "chart") {
      const tab = cur.elements.at(-1);
      if (tab?.type !== "table") throw new Error("[[chart: ...]] must come right after the table with the data, on the same slide");
      cur.elements[cur.elements.length - 1] = { type: "chart", table: tab, kind: chartType(dv), title: dv.title };
      continue;
    }
    if (t.type === "blockquote") cur.notes.push(plainText(t.tokens).trim());
    else cur.elements.push(t);
  }
  return slides.filter((s) => s.title || s.elements.length || s.notes.length);
}

/**
 * pptxgenjs runs for a line of text with bold, italic and links. The paragraph options
 * (`par`: list, indent, spacing) go only on the first run: on a later run pptxgenjs would open
 * another paragraph, that is another bullet.
 */
function runs(tokens, opts, par = {}, end = true) {
  const segs = segments(tokens).filter((s) => s.text !== "");
  if (!segs.length) segs.push({ text: " " });
  return segs.map((s, i) => ({
    text: s.text,
    options: {
      ...opts, ...(i === 0 ? par : {}), bold: opts.bold || s.bold, italic: s.italic, strike: s.strike ? "sngStrike" : undefined,
      ...(s.code ? { fontFace: "Consolas" } : {}),
      ...(s.link ? { hyperlink: { url: s.link }, color: "0563C1", underline: { style: "sng" } } : {}),
      breakLine: end && i === segs.length - 1,
    },
  }));
}

/** Body paragraphs as pptxgenjs runs, plus the estimated number of lines at that size. */
function bodyLines(elements, size, s, width) {
  const out = [];
  let lines = 0;
  const estimate = (tokens, indent = 0) => {
    const chars = Math.max(10, Math.floor(((width - 0.4 - indent * 0.4) * 72) / (size * 0.5)));
    return Math.max(1, Math.ceil(plainText(tokens).length / chars));
  };
  const list = (tok, level) => {
    for (const item of tok.items) {
      for (const t of item.tokens) {
        if (t.type === "text" || t.type === "paragraph") {
          out.push(...runs(t.tokens ?? [], { fontSize: size, color: s.text }, { bullet: tok.ordered ? { type: "number" } : { indent: 20 }, indentLevel: level, paraSpaceAfter: 6 }));
          lines += estimate(t.tokens ?? [], level);
        } else if (t.type === "list") list(t, level + 1);
      }
    }
  };
  for (const t of elements) {
    if (t.type === "heading") {
      out.push(...runs(t.tokens, { fontSize: size + 2, bold: true, color: s.primary }, { paraSpaceBefore: 6, paraSpaceAfter: 4 }));
      lines += estimate(t.tokens) + 0.4;
    } else if (t.type === "paragraph") {
      if (plainText(t.tokens).trim()) {
        out.push(...runs(t.tokens, { fontSize: size, color: s.text }, { paraSpaceAfter: 8 }));
        lines += estimate(t.tokens) + 0.3;
      }
    } else if (t.type === "list") list(t, 0);
    else if (t.type === "code") {
      for (const line of t.text.split("\n")) {
        out.push({ text: line || " ", options: { fontSize: Math.max(11, size - 4), fontFace: "Consolas", color: s.text, breakLine: true } });
        lines += 0.8;
      }
    }
  }
  return { out, lines };
}

function textSize(elements, s, width, height) {
  for (let size = 24; size > 12; size -= 2) {
    const { lines } = bodyLines(elements, size, s, width);
    if ((lines * size * 1.35) / 72 <= height) return size;
  }
  return 12;
}

const CHART_COLORS = ["ED7D31", "70AD47", "FFC000", "5B9BD5", "A5A5A5", "7030A0", "C00000"];

function cellNumber(text, where) {
  const t = text.replace(/[€%\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) throw new Error(`the chart needs numbers: the cell «${text}» (${where}) is not a number. The first column is the labels, the others only numbers with the decimal point`);
  return Number(t);
}

/** Native PowerPoint chart from the data of a table: first column = labels, the others = series. */
function chart(p, slide, g, s, area) {
  const tab = g.table;
  if (tab.header.length < 2 || !tab.rows.length) throw new Error("the chart needs a table with at least two columns (labels and numbers) and one data row");
  const labels = tab.rows.map((r) => plainText(r[0]?.tokens));
  const columns = g.kind === "pie" ? [1] : tab.header.slice(1).map((_, i) => i + 1);
  const data = columns.map((c) => ({
    name: plainText(tab.header[c].tokens),
    labels,
    values: tab.rows.map((r, k) => cellNumber(plainText(r[c]?.tokens), `row ${k + 1}`)),
  }));
  const colors = [s.primary, ...CHART_COLORS];
  const common = { ...area, showTitle: !!g.title, title: g.title || undefined, titleFontSize: 16, titleColor: s.text, showLegend: data.length > 1 || g.kind === "pie", legendPos: "b", legendFontSize: 12 };
  if (g.kind === "pie") {
    slide.addChart(p.charts.PIE, data, { ...common, chartColors: colors.slice(0, labels.length), showPercent: true, showValue: false, dataLabelColor: "FFFFFF", dataLabelFontSize: 12 });
  } else if (g.kind === "line") {
    slide.addChart(p.charts.LINE, data, { ...common, chartColors: colors.slice(0, data.length), lineSize: 2.5, lineDataSymbolSize: 8, catAxisLabelFontSize: 12, valAxisLabelFontSize: 12 });
  } else {
    slide.addChart(p.charts.BAR, data, { ...common, chartColors: colors.slice(0, data.length), barDir: g.kind === "horizontal" ? "bar" : "col", barGapWidthPct: 60, catAxisLabelFontSize: 12, valAxisLabelFontSize: 12 });
  }
}

function cover(p, sl) {
  const slide = p.addSlide({ masterName: "COVER" });
  slide.addText(sl.title || " ", { placeholder: "title" });
  const subtitle = sl.elements.filter((e) => e.type === "paragraph" || e.type === "heading").map((e) => plainText(e.tokens)).join("\n");
  if (subtitle) slide.addText(subtitle, { x: 0.9, y: 4.1, w: SLIDE_W - 1.8, h: 1.6, fontSize: 22, color: "E8EEF4", fontFace: "Calibri", valign: "top", fit: "shrink" });
  return slide;
}

function table(slide, tok, s, x, y, w) {
  const border = { type: "solid", pt: 0.75, color: "BFBFBF" };
  const cell = (c, i, header) => ({
    text: runs(c?.tokens ?? [], { fontSize: 14, color: header ? "FFFFFF" : s.text, bold: header }, {}, false),
    options: { align: tok.align[i] ?? "left", valign: "middle", border, fill: header ? { color: s.primary } : undefined, margin: [0.04, 0.08, 0.04, 0.08] },
  });
  const rows = [tok.header.map((c, i) => cell(c, i, true)), ...tok.rows.map((r) => tok.header.map((_, i) => cell(r[i], i, false)))];
  slide.addTable(rows, { x, y, w, fontFace: "Calibri" });
  return (rows.length * 0.42);
}

export async function createPptx(markdown, { dir, styleName, noCover = false }) {
  const s = resolveStyle(styleName);
  const p = new pptxgen();
  p.layout = "LAYOUT_WIDE";
  p.author = "Mango Code";
  // The title of every slide is a real «title» placeholder: PowerPoint shows it in the slide list and in the outline.
  p.defineSlideMaster({
    title: "BODY",
    background: { color: "FFFFFF" },
    objects: [
      { rect: { x: MARGIN, y: 1.3, w: 1.4, h: 0.06, fill: { color: s.primary } } },
      { placeholder: { options: { name: "title", type: "title", x: MARGIN, y: 0.4, w: SLIDE_W - 2 * MARGIN, h: 0.9, fontSize: 32, bold: true, color: s.primary, fontFace: "Calibri", valign: "middle", align: "left", fit: "shrink", margin: 0.05 }, text: "" } },
    ],
    slideNumber: { x: SLIDE_W - 1.0, y: SLIDE_H - 0.5, w: 0.6, h: 0.3, fontSize: 11, color: "808080", align: "right" },
  });
  p.defineSlideMaster({
    title: "COVER",
    background: { color: s.primary },
    objects: [
      { placeholder: { options: { name: "title", type: "title", x: 0.9, y: 2.3, w: SLIDE_W - 1.8, h: 1.6, fontSize: 44, bold: true, color: "FFFFFF", fontFace: "Calibri", valign: "bottom", align: "left", fit: "shrink" }, text: "" } },
    ],
  });

  const slideList = groupSlides(blocks(markdown));
  if (!slideList.length) throw new Error("the content is empty");

  slideList.forEach((sl, n) => {
    const textOnly = sl.elements.every((e) => e.type === "paragraph" || e.type === "heading") && !sl.elements.some((e) => e.type === "paragraph" && imagesOf(e.tokens).length);
    let slide;
    if (n === 0 && !noCover && sl.title && textOnly && slideList.length > 1) slide = cover(p, sl);
    else {
      slide = p.addSlide({ masterName: "BODY" });
      if (sl.title) {
        slide.addText(sl.title, { placeholder: "title" });
      }
      const images = sl.elements.flatMap((e) => (e.type === "paragraph" ? imagesOf(e.tokens) : []));
      const tables = sl.elements.filter((e) => e.type === "table");
      const charts = sl.elements.filter((e) => e.type === "chart");
      const texts = sl.elements.filter((e) => e.type !== "table" && e.type !== "chart");
      const beside = images.length === 1 && texts.some((e) => e.type !== "paragraph" || plainText(e.tokens).trim());
      const textW = beside ? BODY.w * 0.52 : BODY.w;
      const textH = tables.length || charts.length || (images.length && !beside) ? BODY.h * 0.5 : BODY.h;

      let yAfter = BODY.y;
      const size = textSize(texts, s, textW, textH);
      const { out, lines } = bodyLines(texts, size, s, textW);
      if (out.length) {
        const h = Math.min(textH, Math.max(0.6, (lines * size * 1.35) / 72 + 0.2));
        slide.addText(out, { x: BODY.x, y: BODY.y, w: textW, h: beside ? BODY.h : h, fontFace: "Calibri", valign: "top", margin: 0.05 });
        yAfter = BODY.y + h + 0.15;
      }
      for (const t of tables) { yAfter += table(slide, t, s, BODY.x, yAfter, BODY.w) + 0.2; }
      for (const g of charts) {
        const top = out.length ? Math.min(yAfter, BODY.y + BODY.h - 3) : BODY.y;
        chart(p, slide, g, s, { x: BODY.x, y: top, w: BODY.w, h: BODY.y + BODY.h - top });
      }

      if (images.length) {
        const loaded = images.map((i) => ({ ...readImage(i.href, dir), alt: i.text }));
        const areas = beside
          ? [{ x: BODY.x + textW + 0.3, y: BODY.y, w: BODY.w - textW - 0.3, h: BODY.h }]
          : loaded.map((_, i) => {
              const w = (BODY.w - 0.3 * (loaded.length - 1)) / loaded.length;
              const y = Math.min(yAfter, SLIDE_H - 0.7 - 1.5);
              return { x: BODY.x + i * (w + 0.3), y, w, h: SLIDE_H - 0.7 - y };
            });
        loaded.forEach((img, i) => {
          const a = areas[i];
          const nativeW = img.width / 96, nativeH = img.height / 96;
          const f = Math.min(a.w / nativeW, a.h / nativeH, 1.5);
          const w = nativeW * f, h = nativeH * f;
          slide.addImage({ data: `image/${img.type === "jpg" ? "jpeg" : img.type};base64,${img.data.toString("base64")}`, x: a.x + (a.w - w) / 2, y: a.y, w, h, altText: img.alt || "image" });
        });
      }
    }
    if (sl.notes.length) slide.addNotes(sl.notes.join("\n"));
  });

  return dropOrphanTypes(Buffer.from(await p.write({ outputType: "nodebuffer" })));
}

/**
 * pptxgenjs declares in the content types one extra `slideMaster` for each master defined, but the part does not exist:
 * PowerPoint tolerates it, a strict check of the package does not. The entries pointing to missing parts are removed.
 */
async function dropOrphanTypes(buf) {
  const z = await JSZip.loadAsync(buf);
  const ct = parseXml(await z.file("[Content_Types].xml").async("string"));
  let removed = 0;
  for (const o of childrenOf(ct.documentElement, "Override")) {
    if (!z.file(o.getAttribute("PartName").slice(1))) { ct.documentElement.removeChild(o); removed++; }
  }
  if (!removed) return buf;
  z.file("[Content_Types].xml", serializeXml(ct));
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
