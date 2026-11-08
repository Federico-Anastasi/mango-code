import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PromptSettings } from "@/session/settings"

let root: string
let folder: string
let defaults: string
const env = process.env.MANGO_SETTINGS

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-"))
  folder = path.join(root, "project")
  fs.mkdirSync(folder)
  defaults = path.join(root, "settings.json")
  process.env.MANGO_SETTINGS = defaults
})

afterEach(() => {
  if (env === undefined) delete process.env.MANGO_SETTINGS
  else process.env.MANGO_SETTINGS = env
  fs.rmSync(root, { recursive: true, force: true })
})

const writeDefaults = (prompt: unknown) => fs.writeFileSync(defaults, JSON.stringify({ prompt }))
const folderFile = () => path.join(folder, ".mango", "settings.json")
const writeFolder = (prompt: unknown) => {
  fs.mkdirSync(path.dirname(folderFile()), { recursive: true })
  fs.writeFileSync(folderFile(), JSON.stringify({ prompt }))
}

describe("prompt settings", () => {
  test("without files every item is on", () => {
    const valid = PromptSettings.load(folder)
    expect(PromptSettings.enabled(valid, "tools", "bash")).toBe(true)
    expect(PromptSettings.enabled(valid, "mcp", "chrome-devtools")).toBe(true)
    expect(PromptSettings.source(valid, "mcp", "chrome-devtools")).toBe("default")
  })

  test("the default file turns off only the items it writes, for every folder", () => {
    writeDefaults({ tools: { webfetch: false }, mcp: { "web-search": false } })
    const valid = PromptSettings.load(folder)
    expect(PromptSettings.enabled(valid, "tools", "webfetch")).toBe(false)
    expect(PromptSettings.enabled(valid, "mcp", "web-search")).toBe(false)
    expect(PromptSettings.enabled(valid, "tools", "bash")).toBe(true)
  })

  test("the folder file wins over the default, both ways", () => {
    writeDefaults({ tools: { webfetch: false }, mcp: { documents: true } })
    writeFolder({ tools: { webfetch: true }, mcp: { documents: false } })
    const valid = PromptSettings.load(folder)
    expect(PromptSettings.enabled(valid, "tools", "webfetch")).toBe(true)
    expect(PromptSettings.source(valid, "tools", "webfetch")).toBe("folder")
    expect(PromptSettings.enabled(valid, "mcp", "documents")).toBe(false)
  })

  test("an invalid file stops with the file name, it is not ignored", () => {
    fs.writeFileSync(defaults, "{ not json")
    expect(() => PromptSettings.load(folder)).toThrow(defaults)
    writeDefaults({ tools: { bash: "no" } })
    expect(() => PromptSettings.load(folder)).toThrow("tools.bash")
    writeDefaults({ thing: {} })
    expect(() => PromptSettings.load(folder)).toThrow("thing")
  })

  test("turning off for all folders writes only the default file; turning on again removes the item", () => {
    PromptSettings.write(folder, "all", "skills", "pdf", false)
    expect(JSON.parse(fs.readFileSync(defaults, "utf8"))).toEqual({ prompt: { skills: { pdf: false } } })
    expect(fs.existsSync(folderFile())).toBe(false)
    PromptSettings.write(folder, "all", "skills", "pdf", true)
    expect(JSON.parse(fs.readFileSync(defaults, "utf8"))).toEqual({ prompt: {} })
  })

  test("\"only this folder\" creates the folder file with the changed item", () => {
    writeDefaults({ mcp: { "chrome-devtools": false } })
    PromptSettings.write(folder, "folder", "mcp", "chrome-devtools", true)
    PromptSettings.write(folder, "folder", "plugins", "mango-discipline", false)
    expect(JSON.parse(fs.readFileSync(folderFile(), "utf8"))).toEqual({
      prompt: { mcp: { "chrome-devtools": true }, plugins: { "mango-discipline": false } },
    })
    // another folder is not affected
    const other = path.join(root, "other")
    fs.mkdirSync(other)
    const valid = PromptSettings.load(other)
    expect(PromptSettings.enabled(valid, "mcp", "chrome-devtools")).toBe(false)
    expect(PromptSettings.enabled(valid, "plugins", "mango-discipline")).toBe(true)
  })

  test("in the folder file an item equal to the default is not left written", () => {
    PromptSettings.write(folder, "folder", "plugins", "mango-discipline", false)
    PromptSettings.write(folder, "folder", "plugins", "mango-discipline", true)
    expect(JSON.parse(fs.readFileSync(folderFile(), "utf8"))).toEqual({ prompt: {} })
  })

  test("the rest of the file is not touched when writing", () => {
    fs.writeFileSync(defaults, JSON.stringify({ other: { x: 1 }, prompt: { skills: { pdf: false } } }))
    PromptSettings.write(folder, "all", "skills", "word", false)
    expect(JSON.parse(fs.readFileSync(defaults, "utf8"))).toEqual({
      other: { x: 1 },
      prompt: { skills: { pdf: false, word: false } },
    })
  })

  test("without the app's default file nothing can be written for all folders", () => {
    delete process.env.MANGO_SETTINGS
    expect(() => PromptSettings.write(folder, "all", "skills", "pdf", false)).toThrow("MANGO_SETTINGS")
  })

  test("the name of an instructions file: relative to the folder, or the bare name if it is Mango Code's, or the path", () => {
    const inside = path.join(folder, ".claude", "rules", "style.md")
    expect(PromptSettings.instructionName(inside, folder)).toBe(".claude/rules/style.md")
    expect(PromptSettings.instructionName(path.join(folder, "CLAUDE.md"), folder)).toBe("CLAUDE.md")
    expect(PromptSettings.instructionName(path.join(root, "dist", "opencode-home", "MANGO.md"), folder)).toBe("MANGO.md")
    const outside = path.join(root, "method", "CLAUDE.md")
    expect(PromptSettings.instructionName(outside, folder)).toBe(outside.replaceAll("\\", "/"))
    expect(PromptSettings.instructionName("https://example.com/rules.md", folder)).toBe("https://example.com/rules.md")
  })

  test("a plugin is named like its file", () => {
    expect(PromptSettings.pluginName("file:///C:/Users/Alice/data/opencode-home/plugin/mango-discipline.js")).toBe("mango-discipline")
    expect(PromptSettings.pluginName("file:///C:/Users/Alice/My%20plugin.mjs")).toBe("My plugin")
    expect(PromptSettings.pluginName("opencode-poe-auth@1.2.0")).toBe("opencode-poe-auth@1.2.0")
  })

  test("the instructions file of a system text is recognized from the first line", () => {
    expect(PromptSettings.instructionsFile("Instructions from: C:\\x\\MANGO.md\nBody")).toBe("C:\\x\\MANGO.md")
    expect(PromptSettings.instructionsFile("Another text")).toBeUndefined()
  })
})
