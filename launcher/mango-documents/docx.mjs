// Markdown -> Word (.docx) with the `docx` library.
import {
  AlignmentType, BorderStyle, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, LevelFormat,
  Document, Packer, PageBreak, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { blocks, directive, fit, imagesOf, plainText, readImage, resolveStyle, segments } from "./common.mjs";

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const PAGE_WIDTH_PX = 600; // A4 text area with 2.5 cm margins, at 96 dpi
const NUM_BULLETS = "bullets", NUM_NUMBERED = "numbered";

function runs(tokens, extra = {}) {
  return segments(tokens).map((s) => {
    const opts = {
      text: s.text, bold: s.bold, italics: s.italic, strike: s.strike, ...extra,
      ...(s.code ? { font: "Consolas", shading: { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } } : {}),
    };
    if (s.text === "\n") return new TextRun({ break: 1 });
    if (s.link) return new ExternalHyperlink({ link: s.link, children: [new TextRun({ ...opts, style: "Hyperlink", color: "0563C1", underline: {} })] });
    return new TextRun(opts);
  });
}

function image(tok, dir) {
  const img = readImage(tok.href, dir);
  const { width, height } = fit(img, PAGE_WIDTH_PX, 700);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
    children: [new ImageRun({ type: img.type, data: img.data, transformation: { width, height }, altText: { name: tok.text || "image", description: tok.text || "image", title: tok.text || "image" } })],
  });
}

function list(tok, level, out) {
  for (const item of tok.items) {
    // The item text is in the first `text` block; nested lists are `list` blocks.
    const text = item.tokens.filter((t) => t.type === "text" || t.type === "paragraph");
    const children = item.tokens.filter((t) => t.type === "list");
    out.push(new Paragraph({
      numbering: { reference: tok.ordered ? NUM_NUMBERED : NUM_BULLETS, level: Math.min(level, 3) },
      spacing: { after: 60 },
      children: text.flatMap((t) => runs(t.tokens ?? [])),
    }));
    for (const c of children) list(c, level + 1, out);
  }
}

function table(tok, s) {
  const n = tok.header.length;
  const border = { style: BorderStyle.SINGLE, size: 4, color: "BFBFBF" };
  const borders = { top: border, bottom: border, left: border, right: border };
  const cell = (c, header, align) => new TableCell({
    borders,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: header ? { type: ShadingType.CLEAR, fill: s.primary, color: "auto" } : undefined,
    children: [new Paragraph({
      alignment: align === "right" ? AlignmentType.RIGHT : align === "center" ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: runs(c.tokens, header ? { bold: true, color: "FFFFFF" } : {}),
    })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: tok.header.map((c, i) => cell(c, true, tok.align[i])) }),
      ...tok.rows.map((r) => new TableRow({ children: Array.from({ length: n }, (_, i) => cell(r[i] ?? { tokens: [] }, false, tok.align[i])) })),
    ],
  });
}

function convert(toks, dir, s, out) {
  for (const t of toks) {
    switch (t.type) {
      case "heading":
        out.push(new Paragraph({ heading: HEADINGS[t.depth - 1], children: runs(t.tokens) }));
        break;
      case "paragraph": {
        const dv = directive(t);
        if (dv?.name === "page") { out.push(new Paragraph({ children: [new PageBreak()] })); break; }
        if (dv?.name === "chart") throw new Error("charts in Word are not possible: put the data in a table, or create the chart in an Excel or PowerPoint file");
        const imgs = imagesOf(t.tokens);
        const text = plainText(t.tokens).trim();
        if (text) out.push(new Paragraph({ spacing: { after: 120 }, children: runs(t.tokens) }));
        for (const i of imgs) out.push(image(i, dir));
        break;
      }
      case "list": list(t, 0, out); out.push(new Paragraph({ spacing: { after: 60 } })); break;
      case "table": out.push(table(t, s), new Paragraph({ spacing: { after: 120 } })); break;
      case "code":
        for (const line of t.text.split("\n")) {
          out.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
            children: [new TextRun({ text: line || " ", font: "Consolas", size: 20 })],
          }));
        }
        out.push(new Paragraph({ spacing: { after: 120 } }));
        break;
      case "blockquote": {
        const inner = [];
        convert(t.tokens, dir, s, inner);
        for (const p of inner) out.push(p);
        break;
      }
      case "hr":
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BFBFBF", space: 1 } }, spacing: { after: 160 } }));
        break;
      case "html": case "text":
        if (t.text?.trim()) out.push(new Paragraph({ children: [new TextRun(t.text.trim())] }));
        break;
      default:
        throw new Error(`unsupported Markdown element: ${t.type}`);
    }
  }
}

export async function createDocx(markdown, { dir, styleName, header }) {
  const s = resolveStyle(styleName);
  const children = [];
  convert(blocks(markdown), dir, s, children);
  if (!children.length) throw new Error("the content is empty");

  const levels = (format, text) => [0, 1, 2, 3].map((l) => ({
    level: l, format, text: text(l), alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 + l * 360, hanging: 360 } } },
  }));
  const heading = (size, before) => ({ run: { font: "Calibri", size, bold: true, color: s.primary }, paragraph: { spacing: { before, after: 120 } } });

  const doc = new Document({
    creator: "Mango Code",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22, color: s.text } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, ...heading(40, 360) },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, ...heading(32, 280) },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, ...heading(26, 200) },
      ],
    },
    numbering: {
      config: [
        { reference: NUM_BULLETS, levels: levels(LevelFormat.BULLET, (l) => ["•", "–", "•", "–"][l]) },
        { reference: NUM_NUMBERED, levels: levels(LevelFormat.DECIMAL, (l) => `%${l + 1}.`) },
      ],
    },
    sections: [{
      properties: { page: { margin: { top: 1418, bottom: 1418, left: 1418, right: 1418 } } },
      ...(header ? { headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: header, color: "808080", size: 18 })] })] }) } } : {}),
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], color: "808080", size: 18 })] })] }) },
      children,
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
