import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { broadFolders, isBroadFolder } from "@/project/broad-folder"

// The real Windows folders of the PC running the test (OneDrive, accents and all), and the same rules on invented ones.
describe.skipIf(process.platform !== "win32")("folders too broad to be a project", () => {
  test("the folders of this PC are broad: user folder, Desktop, Documents, Downloads, the drive root", () => {
    const home = os.homedir()
    for (const folder of [home, path.dirname(home), path.join(home, "Desktop"), path.join(home, "Documents"), path.join(home, "Downloads"), path.parse(home).root])
      expect(isBroadFolder(folder), folder).toBe(true)
  })

  test("the folders Windows names are broad even where the PC moved them", () => {
    expect(broadFolders().length).toBeGreaterThan(8)
    const desktop = broadFolders().find((folder) => /desktop$/i.test(folder))
    expect(desktop).toBeDefined()
    expect(isBroadFolder(desktop!)).toBe(true)
  })

  test("a folder inside them is a project", () => {
    expect(isBroadFolder(path.join(os.homedir(), "Documents", "Mango Code", "sito"))).toBe(false)
    expect(isBroadFolder(path.join(os.homedir(), "Desktop", "ricette"))).toBe(false)
    expect(isBroadFolder(path.join(path.parse(os.homedir()).root, "progetti"))).toBe(false)
  })

  test("Documents moved by OneDrive, with accents in the name, in any spelling", () => {
    const moved = "C:\\Users\\Àngelo\\OneDrive - Società\\Documenti"
    const folders = [moved, "C:\\Users\\Àngelo"]
    expect(isBroadFolder(moved, folders)).toBe(true)
    expect(isBroadFolder("c:\\users\\àngelo\\onedrive - società\\documenti\\", folders)).toBe(true)
    expect(isBroadFolder("\\\\?\\C:\\Users\\Àngelo\\OneDrive - Società\\Documenti", folders)).toBe(true)
    expect(isBroadFolder("C:/Users/Àngelo/OneDrive - Società/Documenti", folders)).toBe(true)
    expect(isBroadFolder(`${moved}\\tesi`, folders)).toBe(false)
  })

  test("OneDrive is broad wherever the PC keeps it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-"))
    const before = process.env.OneDriveCommercial
    process.env.OneDriveCommercial = root
    try {
      expect(isBroadFolder(root)).toBe(true)
      expect(isBroadFolder(path.join(root, "Documenti"))).toBe(false)
    } finally {
      if (before === undefined) delete process.env.OneDriveCommercial
      else process.env.OneDriveCommercial = before
      fs.rmSync(root, { recursive: true })
    }
  })
})
