import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createSubfolder, folderNameProblem } from "../../src/server/shared/mango-project-folder"

const made: string[] = []
const parent = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mango-subfolder-"))
  made.push(dir)
  return dir
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true })
})

describe("the subfolder offered when a folder is too broad", () => {
  test("it is created under the folder the user chose, accents and spaces included", () => {
    const dir = parent()
    expect(createSubfolder(dir, "  Società di Àngelo  ")).toEqual({ directory: path.join(dir, "Società di Àngelo") })
    expect(fs.statSync(path.join(dir, "Società di Àngelo")).isDirectory()).toBe(true)
  })

  test("a name Windows does not allow, an empty one or one in use is refused with the reason", () => {
    const dir = parent()
    for (const name of ["", "   ", "a/b", "a\\b", "x?", "con", "NUL.txt", "fine.", "a".repeat(101)])
      expect(folderNameProblem(name), name).toBeTruthy()
    expect(createSubfolder(dir, "con")).toHaveProperty("error")
    expect(createSubfolder(dir, "sito")).toHaveProperty("directory")
    expect(createSubfolder(dir, "sito")).toHaveProperty("error")
    expect(fs.readdirSync(dir)).toEqual(["sito"])
  })

  test("a parent that does not exist or is not absolute creates nothing", () => {
    const dir = parent()
    expect(createSubfolder(path.join(dir, "manca"), "sito")).toHaveProperty("error")
    expect(createSubfolder("relativa", "sito")).toHaveProperty("error")
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
