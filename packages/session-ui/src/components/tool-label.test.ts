import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { dict as en } from "../../../ui/src/i18n/en"
import { dict as it } from "../../../ui/src/i18n/it"
import {
  friendlyUrl,
  readableName,
  shellSummary,
  snapshotElementName,
  TOOL_LABEL_KEYS,
  toolErrorMessage,
  toolLabel,
} from "./tool-label"

type T = Parameters<typeof toolLabel>[1]
const tr =
  (dict: Record<string, string>): T =>
  (key, params) =>
    (dict[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? ""))
const tIt = tr(it)
const tEn = tr(en)

const snapshot = [
  "## Latest page snapshot",
  'uid=1_0 RootWebArea "Calculator"',
  '  uid=1_4 button "Clear all"',
  '  uid=1_16 button "="',
  "  uid=1_17 button",
].join("\n")

describe("tool translations", () => {
  test("every text used exists in Italian and in English", () => {
    const missing = TOOL_LABEL_KEYS.filter((key) => !(key in it) || !(key in en))
    expect(missing).toEqual([])
  })

  test("every error and detail text exists in Italian and in English", () => {
    const keys = ["browserTimeout", "timeout", "fileNotFound", "editNotFound", "denied"].map((k) => `ui.toolError.${k}`)
    expect(keys.filter((key) => !(key in it) || !(key in en))).toEqual([])
    expect(["ui.toolDetail.parameters", "ui.toolDetail.result"].filter((key) => !(key in it) || !(key in en))).toEqual(
      [],
    )
  })
})

describe("toolLabel", () => {
  test("file tools: verb and file name, present then past", () => {
    const input = { filePath: "C:\\Projects\\app\\index.html" }
    expect(toolLabel({ tool: "write", input, active: true }, tIt)).toEqual({ title: "Scrivo", subtitle: "index.html" })
    expect(toolLabel({ tool: "write", input, active: false }, tIt)).toEqual({
      title: "Ho scritto",
      subtitle: "index.html",
    })
    expect(toolLabel({ tool: "read", input: { filePath: "/a/b.ts" }, active: true }, tEn)).toEqual({
      title: "Reading",
      subtitle: "b.ts",
    })
  })

  test("creating a document: the file name, without the tool's technical name", () => {
    const input = { tipo: "docx", file: "C:\\Projects\\report.docx", contenuto: "# x" }
    expect(toolLabel({ tool: "documents_create", input, active: true }, tIt)).toEqual({
      title: "Creo un documento",
      subtitle: "report.docx",
    })
    expect(toolLabel({ tool: "documents_create", input, active: false }, tEn)).toEqual({
      title: "Created a document",
      subtitle: "report.docx",
    })
  })

  test("the document tools say what they do to the document", () => {
    const input = { file: "C:\\Projects\\report.docx" }
    expect(toolLabel({ tool: "documents_read", input, active: true }, tIt)).toEqual({
      title: "Leggo il documento",
      subtitle: "report.docx",
    })
    expect(toolLabel({ tool: "documents_edit", input, active: false }, tIt)).toEqual({
      title: "Ho modificato il documento",
      subtitle: "report.docx",
    })
    expect(toolLabel({ tool: "documents_convert", input, active: false }, tEn).title).toBe("Created a document")
  })

  test("the closed card says what the command does: the description, or the shortened command", () => {
    expect(toolLabel({ tool: "bash", input: { command: "rm -rf x" }, active: false }, tIt)).toEqual({
      title: "Ho eseguito un comando",
      subtitle: "rm -rf x",
    })
    expect(toolLabel({ tool: "bash", input: {}, active: false }, tIt).subtitle).toBeUndefined()
    expect(shellSummary({ command: "cd 'C:/My Project' && npm   test\nnpm run build" })).toBe("npm test")
    expect(shellSummary({ command: "# try\nls -la" })).toBe("ls -la")
    expect(shellSummary({ command: "x".repeat(100) })).toBe("x".repeat(59) + "…")
    expect(
      toolLabel({ tool: "bash", input: { command: "ls", description: "List the files" }, active: true }, tIt).subtitle,
    ).toBe("List the files")
  })

  test("searches in files and on the web", () => {
    expect(toolLabel({ tool: "grep", input: { pattern: "a.*b" }, active: true }, tIt)).toEqual({
      title: "Cerco nei file",
    })
    expect(toolLabel({ tool: "web-search_search", input: { query: "weather Rome" }, active: true }, tIt)).toEqual({
      title: "Cerco sul web",
      subtitle: "weather Rome",
    })
    expect(
      toolLabel({ tool: "web-search_read_url", input: { url: "https://www.example.com/a/b" }, active: false }, tIt),
    ).toEqual({
      title: "Ho letto una pagina web",
      subtitle: "example.com/a/b",
    })
  })

  test("browser: one label and the action in plain words", () => {
    const page = { url: "file:///C:/Users/Alice/Documents/Mango%20Code/Calculator/index.html" }
    expect(toolLabel({ tool: "chrome-devtools_new_page", input: page, active: true }, tIt)).toEqual({
      title: "Uso il browser",
      subtitle: "apertura di index.html",
    })
    expect(toolLabel({ tool: "chrome-devtools_take_snapshot", input: { pageId: 2 }, active: false }, tIt)).toEqual({
      title: "Ho usato il browser",
      subtitle: "lettura della pagina",
    })
    expect(
      toolLabel({ tool: "chrome-devtools_navigate_page", input: { type: "reload" }, active: true }, tIt).subtitle,
    ).toBe("ricarica della pagina")
  })

  test("the click takes the element name from the last snapshot", () => {
    const click = (uid: string, snap?: string) =>
      toolLabel({ tool: "chrome-devtools_click", input: { uid }, active: true, snapshot: snap }, tIt).subtitle
    expect(click("1_16", snapshot)).toBe("clic su \u201C=\u201D")
    expect(click("1_4", snapshot)).toBe("clic su \u201CClear all\u201D")
    expect(click("1_99", snapshot)).toBe("clic")
    expect(click("1_17", snapshot)).toBe("clic")
    expect(click("1_16")).toBe("clic")
  })

  test("skills and unknown tools never show the technical name", () => {
    expect(toolLabel({ tool: "skill", input: { name: "pdf-reader" }, active: true }, tIt)).toEqual({
      title: "Leggo la skill",
      subtitle: "Pdf reader",
    })
    // the technical names of documents become the ones the user knows
    expect(toolLabel({ tool: "skill", input: { name: "pptx" }, active: false }, tIt)).toEqual({
      title: "Ho letto la skill",
      subtitle: "PowerPoint",
    })
    const unknown = toolLabel({ tool: "secret_tool", input: { x: 1 }, active: true }, tIt)
    expect(unknown).toEqual({ title: "Uso uno strumento" })
    expect(toolLabel({ tool: "todowrite", input: {}, active: true }, tIt).title).toBe(
      "Aggiorno la lista delle cose da fare",
    )
  })

  test("the tools of Mango Harness 2 say on what they work, from their own arguments", () => {
    const label = (tool: string, input: Record<string, unknown>) => toolLabel({ tool, input, active: false }, tIt)
    expect(label("write", { path: "C:/shop/prices.csv", content: "a" })).toEqual({ title: "Ho scritto", subtitle: "prices.csv" })
    expect(label("read", { path: "notes/today.md" }).subtitle).toBe("today.md")
    expect(label("terminal", { command: "python report.py" }).subtitle).toBe("python report.py")
    expect(label("powershell", { script: "Get-Date" }).subtitle).toBe("Get-Date")
    expect(label("page_view", { page: "https://www.example.com/menu" }).subtitle).toBe("example.com/menu")
  })

  test("every agent tool has its own label, not the generic one", () => {
    const tools = [
      "read",
      "write",
      "edit",
      "apply_patch",
      "bash",
      "shell",
      "glob",
      "grep",
      "list",
      "webfetch",
      "websearch",
      "task",
      "todowrite",
      "skill",
      "question",
      "web-search_search",
      "web-search_research",
      "web-search_search_images",
      "web-search_read_url",
      "chrome-devtools_click",
      "chrome-devtools_lighthouse_audit",
      // Mango Harness 2
      "terminal",
      "powershell",
      "search",
      "web_search",
      "web_open",
      "page_view",
      "page_look",
      "page_act",
      "ask",
      "plan",
    ]
    const generic = toolLabel({ tool: "unknown", active: true }, tIt).title
    tools.forEach((tool) => expect(toolLabel({ tool, active: true }, tIt).title).not.toBe(generic))
  })
})

describe("the Team's tools", () => {
  const label = (tool: string, input: Record<string, unknown>, t = tIt) => toolLabel({ tool, input, active: false }, t)

  test("each card says what was done, to whom and what was asked", () => {
    expect(label("ask_dev", { instruction: "Create hello.txt with the word hello.\nThen read it back." })).toEqual({
      title: "Ho chiesto al dev",
      subtitle: "Create hello.txt with the word hello.",
    })
    expect(label("launch_agent", { agent: "1" })).toEqual({ title: "Ho avviato un agente", subtitle: "Agente 1" })
    expect(label("ask_agent", { agent: "2", instruction: "Check the prices" })).toEqual({
      title: "Ho chiesto a un agente",
      subtitle: "Agente 2: Check the prices",
    })
    expect(label("close_agent", { agent: "2" }, tEn)).toEqual({ title: "Closed an agent", subtitle: "Agent 2" })
    expect(label("list_agents", {})).toEqual({ title: "Ho guardato gli agenti" })
    expect(label("read_todos", {}, tEn)).toEqual({ title: "Checked progress" })
    expect(label("ask_manager", { message: "Done: hello.txt exists" }, tEn)).toEqual({
      title: "Wrote to the manager",
      subtitle: "Done: hello.txt exists",
    })
    expect(label("ask_manager", { message: "Done: hello.txt exists" })).toEqual({
      title: "Ho scritto al manager",
      subtitle: "Done: hello.txt exists",
    })
    expect(toolLabel({ tool: "ask_manager", input: { message: "x" }, active: true }, tIt).title).toBe("Scrivo al manager")
    expect(toolLabel({ tool: "ask_dev", input: { instruction: "x" }, active: true }, tEn).title).toBe("Asking the dev")
  })

  test("what was asked is one short line, and a card without arguments still reads well", () => {
    expect(label("ask_dev", { instruction: "word ".repeat(40) }).subtitle).toBe(`${"word ".repeat(11)}word…`)
    expect(label("ask_dev", {}).subtitle).toBeUndefined()
    expect(label("ask_agent", { instruction: "Check" }).subtitle).toBe("Check")
    expect(label("ask_agent", { agent: "3" }).subtitle).toBe("Agente 3")
  })

  // The tools the app gives the model: the agent's own, the harnesses', the plugins' and the MCP servers'. The ones the app
  // keeps off (experimental flags of the agent) are not given.
  test("no tool the app gives the model falls back to the generic label", () => {
    const root = path.resolve(import.meta.dir, "..", "..", "..", "..")
    const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8")
    const names = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!)
    const files = (dir: string, ext: string) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f))
    const off = new Set(["lsp", "plan_exit", "execute"])

    const builtin = [
      "bash",
      "task",
      ...files("packages/opencode/src/tool", ".ts").flatMap((f) => names(read(f), /Tool\.define(?:<[^(]*>)?\(\s*"([a-z_]+)"/g)),
    ]
    const harnesses = fs
      .readdirSync(path.join(root, "launcher", "harness"))
      .filter((h) => fs.existsSync(path.join(root, "launcher", "harness", h, "tools.json")))
      .flatMap((h) => Object.keys(JSON.parse(read("launcher", "harness", h, "tools.json"))))
    const plugins = files("launcher/opencode-home/plugin", ".js").flatMap((f) => names(read(f), /^\s*([a-z_]+): tool\(\{/gm))
    const servers = [
      ...names(read("launcher", "mango-websearch-mcp.js"), /\{ name: "([a-z_]+)"/g).map((n) => `web-search_${n}`),
      ...names(read("launcher", "mango-documents", "mcp.mjs"), /^\s+name: "([a-z]+)",/gm).map((n) => `documents_${n}`),
    ]
    const all = [...new Set([...builtin, ...harnesses, ...plugins, ...servers])].filter((n) => !off.has(n))
    expect(all).toContain("ask_dev")
    expect(all).toContain("documents_edit")
    expect(all).toContain("page_act")
    expect(all).toContain("web-search_read_url")

    const generic = toolLabel({ tool: "unknown", active: false }, tIt).title
    expect(all.filter((tool) => toolLabel({ tool, active: false }, tIt).title === generic)).toEqual([])
  })
})

describe("toolErrorMessage", () => {
  test("technical errors in plain words", () => {
    expect(toolErrorMessage("chrome-devtools_new_page", "MCP error -32001: Request timed out", tIt)).toBe(
      "Il browser non ha risposto",
    )
    expect(toolErrorMessage("web-search_search", "request timed out", tIt)).toBe(
      "Lo strumento non ha risposto in tempo",
    )
    expect(toolErrorMessage("read", "File not found: /x/y.txt", tIt)).toBe("Non ho trovato il file")
    expect(toolErrorMessage("edit", "Could not find oldString in the file", tIt)).toBe(
      "Non ho trovato il punto da modificare",
    )
    expect(toolErrorMessage("bash", "The user rejected permission to use this", tEn)).toBe("This wasn't allowed")
    const offline = "ERROR: all engines failed: ddg: FAILED (fetch failed) · brave: FAILED (fetch failed)"
    expect(toolErrorMessage("web-search_search", offline, tIt)).toBe("Nessuna connessione a internet")
    expect(toolErrorMessage("web-search_read_url", "ERROR: getaddrinfo ENOTFOUND example.com", tEn)).toBe(
      "No internet connection",
    )
  })

  test("unknown error: generic message, never the technical text", () => {
    expect(toolErrorMessage("bash", "segfault at 0x0", tIt)).toBe("Operazione non riuscita")
  })
})

describe("helper", () => {
  test("friendlyUrl", () => {
    expect(friendlyUrl("file:///C:/a/b%20c/index.html")).toBe("index.html")
    expect(friendlyUrl("https://www.example.com/")).toBe("example.com")
    expect(friendlyUrl("not a url")).toBe("not a url")
    expect(friendlyUrl(undefined)).toBeUndefined()
  })
  test("readableName", () => {
    expect(readableName("my_nice-tool")).toBe("My nice tool")
    expect(readableName("")).toBeUndefined()
  })
  test("snapshotElementName", () => {
    expect(snapshotElementName(snapshot, "1_16")).toBe("=")
    expect(snapshotElementName(undefined, "1_16")).toBeUndefined()
  })
})
