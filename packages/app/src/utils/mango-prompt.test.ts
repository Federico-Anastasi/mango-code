import { describe, expect, test } from "bun:test"
import { itemLabel, itemsOf, parsePromptSettings, promptTotal, type PromptItem } from "./mango-prompt"

const item = (type: string, name: string, tokens: number | null, enabled = true, source: "default" | "folder" | null = "default") => ({
  type,
  name,
  tokens,
  enabled,
  source,
})

const body = {
  directory: "C:\\Projects\\film",
  model: "qwen",
  file: { default: "C:\\data\\settings.json", folder: "C:\\Projects\\film\\.mango\\settings.json" },
  items: [
    item("base", "base", 1400, true, null),
    item("tools", "bash", 800),
    item("tools", "read", 250),
    item("tools", "webfetch", 150, false),
    item("tools", "new", null),
    item("mcp", "chrome-devtools", 1100, true, "folder"),
    item("skills", "pdf", 55),
  ],
}

describe("prompt settings in the page", () => {
  test("reads the server response", () => {
    const s = parsePromptSettings(body)!
    expect(s.directory).toBe("C:\\Projects\\film")
    expect(s.items).toHaveLength(7)
    expect(s.items[5]).toEqual({ type: "mcp", name: "chrome-devtools", tokens: 1100, enabled: true, source: "folder" })
  })

  test("a response that is not the expected one is not read", () => {
    expect(parsePromptSettings(undefined)).toBeUndefined()
    expect(parsePromptSettings({ error: "no" })).toBeUndefined()
    expect(parsePromptSettings({ ...body, items: [{ type: "mcp" }] })).toBeUndefined()
  })

  test("the items of a section go from the heaviest, the unmeasured ones last", () => {
    const s = parsePromptSettings(body)!
    expect(itemsOf(s, "tools").map((v) => v.name)).toEqual(["bash", "read", "webfetch", "new"])
    expect(itemsOf(s, "base").map((v) => v.name)).toEqual(["base"])
  })

  test("the total is the base plus the enabled items; the unmeasured ones are counted apart, never estimated", () => {
    const s = parsePromptSettings(body)!
    // 1400 + 800 + 250 + 1100 + 55: webfetch is off, "new" is not measured
    expect(promptTotal(s)).toEqual({ tokens: 3605, unmeasured: 1 })
    const disabled = { ...s, items: s.items.map((v): PromptItem => (v.type === "mcp" ? { ...v, enabled: false } : v)) }
    expect(promptTotal(disabled).tokens).toBe(2505)
  })

  test("the name of an instructions file from another folder is shortened, the rest stays", () => {
    expect(itemLabel("instructions", "C:/Projects/method/CLAUDE.md")).toBe("CLAUDE.md")
    expect(itemLabel("instructions", ".claude/rules/style.md")).toBe(".claude/rules/style.md")
    expect(itemLabel("instructions", "MANGO.md")).toBe("MANGO.md")
    expect(itemLabel("mcp", "chrome-devtools")).toBe("chrome-devtools")
  })
})
