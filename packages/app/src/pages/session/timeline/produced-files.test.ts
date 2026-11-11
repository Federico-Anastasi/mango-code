import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { lastWrittenPage, producedFiles, summaryFiles } from "./produced-files"
import type { SummaryDiff } from "./timeline-row"

const tool = (name: string, input: Record<string, unknown>, output: string, status = "completed") =>
  ({ type: "tool", tool: name, state: { status, input, output } }) as unknown as Part

const diff = (file: string) => ({ file, additions: 1, deletions: 0 }) satisfies SummaryDiff

describe("producedFiles", () => {
  test("write, edit and documents_create completed, without duplicates", () => {
    const parts = [
      tool("write", { filePath: "C:\\P\\index.html" }, "ok"),
      tool("documents_create", { file: "shopping.docx" }, "File created: C:\\P\\shopping.docx (10 KB)"),
      tool("edit", { filePath: "c:/p/index.html" }, "ok"),
      tool("bash", { command: "ls" }, "File created: x (1 KB)"),
      tool("write", { filePath: "C:\\P\\failed.txt" }, "boom", "error"),
    ]
    expect(producedFiles(parts)).toEqual(["C:\\P\\index.html", "C:\\P\\shopping.docx"])
  })

  test("without tools there is nothing", () => {
    expect(producedFiles([{ type: "text", text: "hello" } as unknown as Part])).toEqual([])
  })
})

describe("lastWrittenPage", () => {
  test("the last HTML page a tool wrote, even if the same file was written before and other files came after", () => {
    const parts = [
      tool("write", { filePath: "C:\\P\\a.html" }, "ok"),
      tool("write", { filePath: "C:\\P\\b.htm" }, "ok"),
      tool("edit", { filePath: "C:\\P\\a.html" }, "ok"),
      tool("write", { filePath: "C:\\P\\style.css" }, "ok"),
      tool("documents_create", { file: "r.docx" }, "File created: C:\\P\\r.docx (10 KB)"),
      tool("write", { filePath: "C:\\P\\c.html" }, "boom", "error"),
    ]
    expect(lastWrittenPage(parts)).toBe("C:\\P\\a.html")
  })

  test("without a page written there is none", () => {
    expect(lastWrittenPage([tool("write", { filePath: "C:\\P\\a.css" }, "ok")])).toBeUndefined()
    expect(lastWrittenPage([])).toBeUndefined()
  })
})

describe("summaryFiles", () => {
  test("a file already recorded by git is not repeated, the others are added with the relative path", () => {
    const files = summaryFiles([diff("index.html")], ["C:\\P\\index.html", "C:\\P\\docs\\shopping.docx"], "C:\\P")
    expect(files.map((f) => [f.file, f.path, !!f.diff])).toEqual([
      ["index.html", "C:\\P\\index.html", true],
      ["docs/shopping.docx", "C:\\P\\docs\\shopping.docx", false],
    ])
  })

  test("without git only the files of the tools remain", () => {
    expect(summaryFiles([], ["C:\\P\\shopping.docx"], "C:\\P")).toEqual([{ file: "shopping.docx", path: "C:\\P\\shopping.docx" }])
  })
})
