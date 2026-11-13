import { describe, expect, test } from "bun:test"
import {
  groupCount,
  itemLabel,
  itemsOf,
  mcpLabel,
  parsePromptSettings,
  PROMPT_GROUPS,
  promptShares,
  promptTotal,
  type PromptItem,
} from "./mango-prompt"

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

  test("an item that weighs nothing is not listed while it is on, but stays listed once it is off to be turned back on", () => {
    const s = parsePromptSettings({
      ...body,
      items: [...body.items, item("plugins", "mango-project", 0), item("plugins", "mango-web-diet", 0, false)],
    })!
    expect(itemsOf(s, "plugins").map((v) => v.name)).toEqual(["mango-web-diet"])
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

  test("Mango Code's own MCP servers go by the name the user knows; the user's servers keep theirs", () => {
    const servers = ["chrome-devtools", "documents", "web-search", "echo", "toString"]
    const italian = { browser: "Browser", documents: "Documenti", search: "Ricerca" } as const
    const label = (name: string, list = servers) => mcpLabel(name, list, (own) => italian[own])
    expect(label("chrome-devtools")).toBe("Browser")
    expect(label("documents")).toBe("Documenti")
    expect(label("web-search")).toBe("Ricerca")
    expect(label("echo")).toBe("echo")
    expect(label("toString")).toBe("toString")
  })

  test("a user's server already called like one of ours leaves both with their own name", () => {
    const italian = { browser: "Browser", documents: "Documenti", search: "Ricerca" } as const
    const servers = ["chrome-devtools", "browser", "web-search"]
    expect(mcpLabel("chrome-devtools", servers, (own) => italian[own])).toBe("chrome-devtools")
    expect(mcpLabel("browser", servers, (own) => italian[own])).toBe("browser")
    // the other of ours keeps the known name
    expect(mcpLabel("web-search", servers, (own) => italian[own])).toBe("Ricerca")
  })
})

describe("the rows of the Agent section", () => {
  const group = (id: string) => PROMPT_GROUPS.find((candidate) => candidate.id === id)!
  const settings = () =>
    parsePromptSettings({
      ...body,
      items: [
        ...body.items,
        item("skills", "greeting", 30, false),
        item("instructions", "CLAUDE.md", 400),
        item("plugins", "mango-discipline", 120),
        item("plugins", "mango-project", 0),
      ],
    })!

  test("four rows: tools, MCP servers, skills, and instructions together with the plugins", () => {
    expect(PROMPT_GROUPS.map((candidate) => candidate.id)).toEqual(["tools", "mcp", "skills", "instructions"])
    expect(group("instructions").kinds).toEqual(["instructions", "plugins"])
  })

  test("a row counts what is on out of what it lists; a plugin that weighs nothing is not listed, so not counted", () => {
    expect(groupCount(settings(), group("tools"))).toEqual({ on: 3, all: 4 })
    expect(groupCount(settings(), group("mcp"))).toEqual({ on: 1, all: 1 })
    expect(groupCount(settings(), group("skills"))).toEqual({ on: 1, all: 2 })
    expect(groupCount(settings(), group("instructions"))).toEqual({ on: 2, all: 2 })
  })

  test("the bar has the base and each row by what its enabled, measured items weigh, and the parts make the total", () => {
    const current = settings()
    expect(promptShares(current)).toEqual([
      { id: "base", tokens: 1400 },
      { id: "tools", tokens: 1050 },
      { id: "mcp", tokens: 1100 },
      { id: "skills", tokens: 55 },
      { id: "instructions", tokens: 520 },
    ])
    expect(promptShares(current).reduce((sum, share) => sum + share.tokens, 0)).toBe(promptTotal(current).tokens)
  })

  test("a row with everything off or unmeasured has no part in the bar", () => {
    const current = parsePromptSettings({ ...body, items: body.items.map((v) => (v.type === "mcp" ? { ...v, enabled: false } : v)) })!
    expect(promptShares(current).map((share) => share.id)).toEqual(["base", "tools", "skills"])
  })
})
