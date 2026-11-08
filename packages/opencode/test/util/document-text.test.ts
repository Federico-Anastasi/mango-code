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
