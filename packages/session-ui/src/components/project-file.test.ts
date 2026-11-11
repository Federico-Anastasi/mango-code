import { describe, expect, test } from "bun:test"
import {
  formatFileSize,
  isProjectFileCard,
  previewKind,
  projectFileKind,
  projectFilePath,
  producedFilePath,
  projectFileProblem,
  projectRelativePath,
  samePathKey,
} from "./project-file"

describe("projectFileKind", () => {
  test("recognizes documents by extension, whatever the case and the path", () => {
    expect(projectFileKind("report.docx")).toBe("word")
    expect(projectFileKind("docs/Budget.XLSX")).toBe("excel")
    expect(projectFileKind("C:\\Projects\\slide.pptx")).toBe("powerpoint")
    expect(projectFileKind("a/b/c.pdf")).toBe("pdf")
    expect(projectFileKind("logo.PNG")).toBe("image")
    expect(projectFileKind("index.html")).toBe("web")
  })

  test("no extension or unknown is a generic file", () => {
    expect(projectFileKind("Makefile")).toBe("file")
    expect(projectFileKind(".gitignore")).toBe("file")
    expect(projectFileKind("data.xyz")).toBe("file")
  })

  test("card for formats without a line-by-line diff, accordion for text", () => {
    for (const name of ["a.docx", "a.xlsx", "a.pptx", "a.pdf", "a.png", "a.zip"]) expect(isProjectFileCard(name)).toBe(true)
    for (const name of ["index.html", "a.ts", "note.md", "data.csv", "Makefile"]) expect(isProjectFileCard(name)).toBe(false)
  })
})

describe("previewKind", () => {
  test("a PDF and the pictures can be shown in the panel, an SVG as a picture; the other documents cannot", () => {
    expect(previewKind("a/b/c.PDF")).toBe("pdf")
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.ico", "logo.svg"]) expect(previewKind(name)).toBe("image")
    for (const name of ["a.docx", "a.xlsx", "a.pptx", "index.html", "a.txt", "a.zip", "Makefile"]) expect(previewKind(name)).toBeUndefined()
  })
})

describe("projectFilePath", () => {
  test("joins with the separator of the project folder", () => {
    expect(projectFilePath("C:\\Users\\Alice\\Project", "docs/report.docx")).toBe("C:\\Users\\Alice\\Project\\docs\\report.docx")
    expect(projectFilePath("C:\\Users\\Alice\\Project\\", "a.pdf")).toBe("C:\\Users\\Alice\\Project\\a.pdf")
    expect(projectFilePath("/home/mango/p", "docs/a.pdf")).toBe("/home/mango/p/docs/a.pdf")
  })

  test("an already absolute path is left alone", () => {
    expect(projectFilePath("C:\\P", "D:\\other\\a.pdf")).toBe("D:\\other\\a.pdf")
    expect(projectFilePath("C:\\P", "\\\\server\\share\\a.pdf")).toBe("\\\\server\\share\\a.pdf")
  })
})

describe("formatFileSize", () => {
  test("readable bytes, KB and MB", () => {
    expect(formatFileSize(512, "it")).toBe("512 B")
    expect(formatFileSize(11 * 1024, "it")).toBe("11 KB")
    expect(formatFileSize(1.5 * 1024 * 1024, "it")).toBe("1,5 MB")
    expect(formatFileSize(1.5 * 1024 * 1024, "en")).toBe("1.5 MB")
  })
})

describe("projectFileProblem", () => {
  test("the bridge code chooses the reason", () => {
    expect(projectFileProblem({ code: "not_found", message: "x" })).toBe("missing")
    expect(projectFileProblem({ code: "blocked_type", message: "x" })).toBe("blocked")
    expect(projectFileProblem({ code: "too_large", message: "x" })).toBe("large")
    expect(projectFileProblem({ code: "unreadable", message: "x" })).toBe("unreadable")
    expect(projectFileProblem({ code: "forbidden", message: "x" })).toBe("failed")
    expect(projectFileProblem(new Error("boom"))).toBe("failed")
    expect(projectFileProblem(undefined)).toBe("failed")
  })
})

describe("producedFilePath", () => {
  test("write and edit: the path in the parameters", () => {
    expect(producedFilePath("write", { filePath: "C:\\P\\index.html" }, "ok")).toBe("C:\\P\\index.html")
    expect(producedFilePath("edit", { filePath: "/p/a.ts" }, "ok")).toBe("/p/a.ts")
  })

  test("documents_create: the path in the confirmation message", () => {
    expect(producedFilePath("documents_create", { file: "shopping.docx" }, "File created: C:\\P\\shopping.docx (10 KB)")).toBe(
      "C:\\P\\shopping.docx",
    )
    expect(producedFilePath("documents_create", {}, "File created: C:\\P\\a.docx (3 KB)")).toBe("C:\\P\\a.docx")
    expect(producedFilePath("documents_create", {}, "ERROR: missing file name")).toBeUndefined()
  })

  test("other tools produce no files", () => {
    expect(producedFilePath("bash", { command: "ls" }, "File created: x (1 KB)")).toBeUndefined()
    expect(producedFilePath("write", undefined, "ok")).toBeUndefined()
  })
})

describe("path comparison", () => {
  test("same key for different slashes and case", () => {
    expect(samePathKey("C:\\Users\\Alice\\P\\")).toBe(samePathKey("c:/users/alice/p"))
  })

  test("relative only when inside the project", () => {
    expect(projectRelativePath("C:\\P", "C:\\P\\docs\\a.docx")).toBe("docs/a.docx")
    expect(projectRelativePath("C:\\P", "c:/p/a.docx")).toBe("a.docx")
    expect(projectRelativePath("C:\\P", "C:\\Other\\a.docx")).toBe("C:/Other/a.docx")
    expect(projectRelativePath("C:\\P", "C:\\Pluto\\a.docx")).toBe("C:/Pluto/a.docx")
  })
})
