// Markdown -> PDF with `pdfmake`. Characters (accented ones too) come from Arial and Consolas,
// which are on every Windows: no font to carry along.
import fs from "node:fs";
import path from "node:path";
import pdfmake from "pdfmake";
import { blocks, directive, fit, imagesOf, plainText, readImage, resolveStyle, segments } from "./common.mjs";

const FONT_DIR = path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
const FONTS = {
  Arial: { normal: "arial.ttf", bold: "arialbd.ttf", italics: "ariali.ttf", bolditalics: "arialbi.ttf" },
  Consolas: { normal: "consola.ttf", bold: "consolab.ttf", italics: "consolai.ttf", bolditalics: "consolaz.ttf" },
};
const MARGIN = 56;
const usableWidth = (landscape) => (landscape ? 842 : 595) - 2 * MARGIN; // A4 in points minus the margins

function registerFonts() {
  const fonts = {};
  const allowed = new Set();
  for (const [name, file] of Object.entries(FONTS)) {
    fonts[name] = Object.fromEntries(Object.entries(file).map(([k, f]) => {
      const p = path.join(FONT_DIR, f);
      if (!fs.existsSync(p)) throw new Error(`missing font ${p}, needed for the PDF`);
      allowed.add(path.resolve(p).toLowerCase());
      return [k, p];
    }));
  }
  pdfmake.setFonts(fonts);
  // The library may read only these fonts and no web address: images are passed already read.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((p) => allowed.has(path.resolve(p).toLowerCase()));
}

function text(tokens) {
  return segments(tokens).map((s) => ({
    text: s.text, bold: s.bold, italics: s.italic, decoration: s.strike ? "lineThrough" : s.link ? "underline" : undefined,
    link: s.link, color: s.link ? "#0563C1" : undefined,
    ...(s.code ? { font: "Consolas", background: "#EEEEEE" } : {}),
  }));
}

function list(tok) {
  const items = tok.items.map((item) => {
    const pieces = [];
    for (const t of item.tokens) {
      if (t.type === "text" || t.type === "paragraph") pieces.push({ text: text(t.tokens ?? []) });
      else if (t.type === "list") pieces.push(list(t));
    }
    return pieces.length === 1 ? pieces[0] : { stack: pieces };
  });
  return tok.ordered ? { ol: items, margin: [0, 0, 0, 6] } : { ul: items, margin: [0, 0, 0, 6] };
}

function convert(toks, dir, s, out, usable) {
  for (const t of toks) {
    switch (t.type) {
      case "heading":
        out.push({ text: text(t.tokens), style: `h${Math.min(t.depth, 4)}` });
        break;
      case "paragraph": {
        const dv = directive(t);
        if (dv?.name === "page") { out.push({ text: "", pageBreak: "after" }); break; }
        if (dv?.name === "chart") throw new Error("charts in PDF are not possible: put the data in a table, or create the chart in an Excel or PowerPoint file");
        if (plainText(t.tokens).trim()) out.push({ text: text(t.tokens), margin: [0, 0, 0, 7] });
        for (const i of imagesOf(t.tokens)) {
          const img = readImage(i.href, dir);
          if (img.type === "gif") throw new Error(`image ${img.path}: PDF needs PNG or JPEG`);
          const { width, height } = fit(img, usable, 600);
          out.push({ image: `data:image/${img.type === "jpg" ? "jpeg" : "png"};base64,${img.data.toString("base64")}`, width, height, alignment: "center", margin: [0, 4, 0, 8] });
        }
        break;
      }
      case "list": out.push(list(t)); break;
      case "table": {
        const cell = (c, i, header) => ({
          text: text(c?.tokens ?? []), alignment: t.align[i] ?? "left",
          ...(header ? { bold: true, color: "#FFFFFF", fillColor: `#${s.primary}` } : {}),
        });
        out.push({
          table: {
            headerRows: 1,
            widths: t.header.map(() => "*"),
            body: [t.header.map((c, i) => cell(c, i, true)), ...t.rows.map((r) => t.header.map((_, i) => cell(r[i], i, false)))],
          },
          layout: { hLineColor: () => "#BFBFBF", vLineColor: () => "#BFBFBF", hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 4, paddingBottom: () => 4 },
          margin: [0, 2, 0, 10],
        });
        break;
      }
      case "code":
        out.push({ table: { widths: ["*"], body: [[{ text: t.text, font: "Consolas", fontSize: 9, fillColor: "#F2F2F2" }]] }, layout: "noBorders", margin: [0, 2, 0, 8] });
        break;
      case "blockquote": {
        const inner = [];
        convert(t.tokens, dir, s, inner, usable);
        out.push({ stack: inner, margin: [14, 0, 0, 4], color: "#555555", italics: true });
        break;
      }
      case "hr":
        out.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: usable, y2: 0, lineWidth: 0.7, lineColor: "#BFBFBF" }], margin: [0, 4, 0, 10] });
        break;
      case "html": case "text":
        if (t.text?.trim()) out.push({ text: t.text.trim(), margin: [0, 0, 0, 7] });
        break;
      default:
        throw new Error(`unsupported Markdown element: ${t.type}`);
    }
  }
}

export async function createPdf(markdown, { dir, styleName, header, landscape = false }) {
  const s = resolveStyle(styleName);
  registerFonts();
  const content = [];
  convert(blocks(markdown), dir, s, content, usableWidth(landscape));
  if (!content.length) throw new Error("the content is empty");
  const heading = (fontSize, before) => ({ fontSize, bold: true, color: `#${s.primary}`, margin: [0, before, 0, 6] });
  const def = {
    pageSize: "A4",
    pageOrientation: landscape ? "landscape" : "portrait",
    pageMargins: [56, 56, 56, 64],
    info: { creator: "Mango Code" },
    defaultStyle: { font: "Arial", fontSize: 11, lineHeight: 1.25, color: `#${s.text}` },
    styles: { h1: heading(22, 14), h2: heading(17, 12), h3: heading(14, 10), h4: heading(12, 8) },
    ...(header ? { header: { text: header, alignment: "right", fontSize: 9, color: "#808080", margin: [56, 28, 56, 0] } } : {}),
    footer: (page) => ({ text: String(page), alignment: "center", fontSize: 9, color: "#808080", margin: [0, 24, 0, 0] }),
    content,
  };
  return Buffer.from(await pdfmake.createPdf(def).getBuffer());
}
