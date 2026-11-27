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

  test("each harness has its own items: the default one's are at the top of the file, the others' under their name", () => {
    writeDefaults({ tools: { bash: false } })
    PromptSettings.write(folder, "all", "tools", "terminal", false, "mango-harness-2")
    PromptSettings.write(folder, "folder", "hooks", "would-lose", false, "mango-harness-2")
    expect(JSON.parse(fs.readFileSync(defaults, "utf8"))).toEqual({
      prompt: { tools: { bash: false } },
      harnesses: { "mango-harness-2": { prompt: { tools: { terminal: false } } } },
    })
    const second = PromptSettings.load(folder, "mango-harness-2")
    expect(PromptSettings.enabled(second, "tools", "terminal")).toBe(false)
    expect(PromptSettings.enabled(second, "tools", "bash")).toBe(true)
    expect(PromptSettings.chosen(second, "hooks", "would-lose")).toBe(false)
    expect(PromptSettings.chosen(second, "hooks", "every-calls")).toBeUndefined()
    const first = PromptSettings.load(folder)
    expect(PromptSettings.enabled(first, "tools", "bash")).toBe(false)
    expect(PromptSettings.enabled(first, "tools", "terminal")).toBe(true)
  })

  test("a harness removed leaves the file for all folders: a new one with its name starts with every item as it comes", () => {
    writeDefaults({ tools: { bash: false } })
    PromptSettings.write(folder, "all", "tools", "read", false, "mine")
    PromptSettings.write(folder, "all", "tools", "read", false, "other")
    PromptSettings.forget("mine")
    expect(JSON.parse(fs.readFileSync(defaults, "utf8"))).toEqual({
      prompt: { tools: { bash: false } },
      harnesses: { other: { prompt: { tools: { read: false } } } },
    })
    expect(PromptSettings.enabled(PromptSettings.load(folder, "mine"), "tools", "read")).toBe(true)
    PromptSettings.forget("never-there")
    fs.rmSync(defaults)
    PromptSettings.forget("mine")
    expect(fs.existsSync(defaults)).toBe(false)
  })

  test("a harness's items that are not an object stop with the file name", () => {
    fs.writeFileSync(defaults, JSON.stringify({ harnesses: { mine: { prompt: { tools: { x: "off" } } } } }))
    expect(() => PromptSettings.load(folder, "mine")).toThrow("tools.x")
    fs.writeFileSync(defaults, JSON.stringify({ harnesses: [] }))
    expect(() => PromptSettings.load(folder, "mine")).toThrow(defaults)
  })

  test("the name of an instructions file: its place from the folder when it is the folder's or above it, otherwise the bare name", () => {
    const inside = path.join(folder, ".claude", "rules", "style.md")
    expect(PromptSettings.instructionName(inside, folder)).toBe(".claude/rules/style.md")
    expect(PromptSettings.instructionName(path.join(folder, "CLAUDE.md"), folder)).toBe("CLAUDE.md")
    expect(PromptSettings.instructionName(path.join(path.dirname(folder), "CLAUDE.md"), folder)).toBe("../CLAUDE.md")
    expect(PromptSettings.instructionName(path.join(root, "method", "CLAUDE.md"), folder)).toBe("CLAUDE.md")
    expect(PromptSettings.instructionName("https://example.com/rules.md", folder)).toBe("https://example.com/rules.md")
  })

  test("a plugin is named like its file", () => {
    expect(PromptSettings.pluginName("file:///C:/Users/Alice/data/opencode-home/plugin/mango-discipline.js")).toBe("mango-discipline")
    expect(PromptSettings.pluginName("file:///C:/Users/Alice/My%20plugin.mjs")).toBe("My plugin")
    expect(PromptSettings.pluginName("example-plugin@1.2.0")).toBe("example-plugin@1.2.0")
  })

  test("the instructions file of a system text is recognized from the first line", () => {
    expect(PromptSettings.instructionsFile("Instructions from: .claude/rules/style.md\nBody")).toBe(".claude/rules/style.md")
    expect(PromptSettings.instructionsFile("Another text")).toBeUndefined()
  })
})
