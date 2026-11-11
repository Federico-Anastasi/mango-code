import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { documentKind, documentToText } from "../../src/util/document-text"

const read = (name: string) => fs.readFileSync(path.join(import.meta.dir, "..", "fixtures", "documents", name))

describe("documentKind", () => {
  test("recognizes the format from the type or the extension", () => {
    expect(documentKind("a.DOCX", undefined)).toBe("docx")
    expect(documentKind("a.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("xlsx")
    expect(documentKind("slide.pptx", "application/octet-stream")).toBe("pptx")
    expect(documentKind("a", "application/pdf")).toBe("pdf")
  })

  test("anything else is not a document", () => {
    expect(documentKind("a.txt", "text/plain")).toBeUndefined()
    expect(documentKind("a.doc", undefined)).toBeUndefined()
    expect(documentKind(undefined, undefined)).toBeUndefined()
  })
})

describe("documentToText", () => {
  test("Word: headings, bold, lists and tables in Markdown", async () => {
    const text = await documentToText("docx", read("memo.docx"))
    expect(text).toContain("# Relazione trimestrale")
    expect(text).toContain("**12%**")
    expect(text).toContain("## Punti chiave")
    expect(text).toMatch(/-\s+Nuovi clienti: Milano e Torino/)
    expect(text).toContain("| Voce | Q1 | Q2 |")
    expect(text).toContain("| Ricavi | 1200 | 1500 |")
  })

  test("Excel: one block per sheet, numbered rows, formulas shown when they have no result", async () => {
    const text = await documentToText("xlsx", read("balance-sheet.xlsx"))
    expect(text).toContain("## Sheet «Spese»")
    expect(text).toContain("| 1 | Voce | Gennaio | Febbraio | Totale |")
    expect(text).toContain("| 3 | Luce | 60 | 75.5 | =B3+C3 |")
    expect(text).toContain("## Sheet «Note»")
    expect(text).toContain("Valori in euro")
  })

  test("PowerPoint: one section per slide, speaker notes, without the page number", async () => {
    const text = await documentToText("pptx", read("slide.pptx"))
    expect(text).toContain("## Slide 1")
    expect(text).toContain("- Piano 2027")
    expect(text).toContain("## Slide 2")
    expect(text).toContain("- Crescere del 15%")
    expect(text).toContain("Speaker notes:\nDire che le stime sono prudenti.")
    expect(text).not.toMatch(/^- 2$/m)
  })

  test("PDF: text per page, accents included", async () => {
    const text = await documentToText("pdf", read("report.pdf"))
    expect(text).toContain("## Page 1")
    expect(text).toContain("àèìòù")
  })

  test("a file that is not of the declared format gives an error, not empty text", async () => {
    await expect(documentToText("docx", Buffer.from("i am not a document"))).rejects.toThrow()
    await expect(documentToText("pdf", Buffer.from("%PDF-1.4 broken"))).rejects.toThrow()
  })
})

describe("documentToText on a zip that declares more than it should", () => {
  // A zip that unpacks to gigabytes is a few megabytes: the sizes the entries declare are checked before anything is
  // unpacked. Here the declared size of the first entry of a real document is raised in its central directory.
  function declaring(name: string, size: number) {
    const bytes = new Uint8Array(read(name))
    const view = new DataView(bytes.buffer)
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue
      view.setUint32(i + 24, size, true)
      return bytes
    }
    throw new Error("no central directory")
  }

  for (const [kind, name] of [["docx", "memo.docx"], ["xlsx", "balance-sheet.xlsx"], ["pptx", "slide.pptx"]] as const) {
    test(`${kind}: refused before unpacking, with the reason`, async () => {
      await expect(documentToText(kind, declaring(name, 600 * 1024 * 1024))).rejects.toThrow("too big once unpacked")
    })
  }

  test("the real documents are far below the limit", async () => {
    expect(await documentToText("pptx", read("slide.pptx"))).toContain("## Slide 1")
  })
})

describe("PowerPoint with slides in another order than their file numbers", () => {
  const text = (words: string) => `<p:sp><p:txBody><a:p><a:r><a:t>${words}</a:t></a:r></a:p></p:txBody></p:sp>`
  const relations = (...items: [id: string, type: string, target: string][]) =>
    `<Relationships>${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")}</Relationships>`

  // Presentation order: the slide in slide2.xml first, then slide1.xml. The notes of slide1.xml are notesSlide2.xml
  // and the notes of slide2.xml are notesSlide1.xml: the numbers in the names say nothing about who goes with whom.
  async function reordered() {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    zip.file("ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId8"/><p:sldId id="256" r:id="rId3"/></p:sldIdLst></p:presentation>`)
    zip.file("ppt/_rels/presentation.xml.rels", relations(["rId3", "slide", "slides/slide1.xml"], ["rId8", "slide", "slides/slide2.xml"]))
    zip.file("ppt/slides/slide1.xml", text("Sold as second"))
    zip.file("ppt/slides/slide2.xml", text("Sold as first"))
    zip.file("ppt/slides/_rels/slide1.xml.rels", relations(["rId1", "notesSlide", "../notesSlides/notesSlide2.xml"]))
    zip.file("ppt/slides/_rels/slide2.xml.rels", relations(["rId1", "notesSlide", "../notesSlides/notesSlide1.xml"]))
    zip.file("ppt/notesSlides/notesSlide1.xml", text("Notes of the first"))
    zip.file("ppt/notesSlides/notesSlide2.xml", text("Notes of the second"))
    return zip.generateAsync({ type: "uint8array" })
  }

  test("the slides come in presentation order and each has its own notes", async () => {
    expect(await documentToText("pptx", await reordered())).toBe(
      ["## Slide 1", "- Sold as first", "", "Speaker notes:", "Notes of the first", "", "## Slide 2", "- Sold as second", "", "Speaker notes:", "Notes of the second"].join("\n"),
    )
  })
})

describe("PowerPoint that is not whole", () => {
  test("a presentation with no slides or with a slide missing is an error, not empty text", async () => {
    const { default: JSZip } = await import("jszip")
    const empty = new JSZip().file("ppt/presentation.xml", "<p:presentation/>")
    await expect(documentToText("pptx", await empty.generateAsync({ type: "uint8array" }))).rejects.toThrow("no slides")
    const lost = new JSZip()
      .file("ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`)
      .file("ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>`)
    await expect(documentToText("pptx", await lost.generateAsync({ type: "uint8array" }))).rejects.toThrow("slide 1")
  })
})
