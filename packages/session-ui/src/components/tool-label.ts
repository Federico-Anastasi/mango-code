import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

type Translate = (key: UiI18nKey, params?: UiI18nParams) => string

export type ToolLabel = {
  /** What it is doing, in words: "Using the browser", "Wrote". */
  title: string
  /** On what, in readable form: a file name, the browser action. No technical names. */
  subtitle?: string
}

type Kind =
  | "read"
  | "write"
  | "edit"
  | "patch"
  | "shell"
  | "search"
  | "webfetch"
  | "websearch"
  | "images"
  | "task"
  | "todo"
  | "skill"
  | "question"
  | "browser"
  | "document"
  | "generic"

const KINDS: Record<string, Kind> = {
  read: "read",
  write: "write",
  edit: "edit",
  patch: "patch",
  apply_patch: "patch",
  bash: "shell",
  shell: "shell",
  glob: "search",
  grep: "search",
  list: "search",
  webfetch: "webfetch",
  websearch: "websearch",
  task: "task",
  todowrite: "todo",
  skill: "skill",
  question: "question",
  "web-search_search": "websearch",
  "web-search_research": "websearch",
  "web-search_search_images": "images",
  "web-search_read_url": "webfetch",
  documents_create: "document",
}

const BROWSER_PREFIX = "chrome-devtools_"

/** Browser action (the tool suffix) -> key of the text that describes it. */
const BROWSER_ACTIONS: Record<string, string> = {
  new_page: "openPage",
  navigate_page: "openPage",
  take_snapshot: "readPage",
  take_screenshot: "screenshot",
  click: "click",
  click_at: "click",
  fill: "fillField",
  fill_form: "fillForm",
  type_text: "typeText",
  press_key: "pressKey",
  hover: "hover",
  drag: "drag",
  upload_file: "uploadFile",
  wait_for: "waitPage",
  list_pages: "listPages",
  select_page: "switchPage",
  close_page: "closePage",
  resize_page: "resize",
  handle_dialog: "dialog",
  evaluate_script: "script",
  list_console_messages: "console",
  get_console_message: "console",
  list_network_requests: "network",
  get_network_request: "network",
  emulate: "emulate",
  performance_start_trace: "performance",
  performance_stop_trace: "performance",
  performance_analyze_insight: "performance",
  lighthouse_audit: "performance",
}

/** Every translation key this module can use: the tests check that they exist in each maintained language. */
export const TOOL_LABEL_KEYS = (() => {
  const kinds: Kind[] = Object.values(KINDS)
    .concat(["browser", "generic"])
    .filter((value, index, all) => all.indexOf(value) === index)
  const labels = kinds.flatMap((kind) => [`ui.tool.label.${kind}.active`, `ui.tool.label.${kind}.done`])
  const actions = [...new Set(Object.values(BROWSER_ACTIONS)), "reload", "back", "forward", "clickBare", "pressKeyBare"]
  return [...labels, ...actions.map((action) => `ui.tool.browser.${action}`)] as UiI18nKey[]
})()

function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

const COMMAND_LIMIT = 60

/**
 * What a shell command does, for the closed row: the description the model gave it; if missing, the
 * command itself shortened (first useful line, without the leading `cd folder &&`).
 */
export function shellSummary(input: Record<string, unknown>) {
  const described = str(input.description)
  if (described) return described
  const line = str(input.command)
    ?.split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#"))
  const command = line?.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, "").replace(/\s+/g, " ")
  if (!command) return
  return command.length > COMMAND_LIMIT ? `${command.slice(0, COMMAND_LIMIT - 1).trimEnd()}…` : command
}

/** "file:///C:/Projects/index.html" -> "index.html"; "https://www.example.com/a/b" -> "example.com/a/b". */
export function friendlyUrl(value: unknown) {
  const text = str(value)
  if (!text) return
  try {
    const url = new URL(text)
    if (url.protocol === "file:") return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? text)
    const path = url.pathname === "/" ? "" : url.pathname
    return `${url.host.replace(/^www\./, "")}${path}`
  } catch {
    return text
  }
}

function fileName(value: unknown) {
  const text = str(value)
  return text ? text.split(/[\\/]/).filter(Boolean).at(-1) : undefined
}

// Names of the document skills as the user knows them (the technical names are the file extensions).
const SKILL_NAMES: Record<string, string> = {
  pptx: "PowerPoint",
  powerpoint: "PowerPoint",
  docx: "Word",
  word: "Word",
  xlsx: "Excel",
  excel: "Excel",
  pdf: "PDF",
}

/** Readable name of a skill: the one non-technical people know, if any, else the cleaned-up name. */
export function skillName(value: unknown) {
  const text = str(value)
  if (!text) return
  return SKILL_NAMES[text.toLowerCase()] ?? readableName(text)
}

/** Readable form of a technical name ("pdf-reader" -> "Pdf reader"). */
export function readableName(value: unknown) {
  const text = str(value)
  if (!text) return
  const spaced = text.replace(/[_-]+/g, " ")
  return spaced[0]!.toUpperCase() + spaced.slice(1)
}

/**
 * Name of the page element with that uid, read from the last browser snapshot:
 * the lines look like `uid=1_16 button "Equals"`.
 */
export function snapshotElementName(snapshot: string | undefined, uid: string | undefined) {
  if (!snapshot || !uid) return
  const escaped = uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const line = new RegExp(`uid=${escaped}\\s+\\S+\\s+"([^"\\n]*)"`)
  return snapshot.match(line)?.[1] || undefined
}

function quoted(value: string | undefined) {
  return value ? `\u201C${value}\u201D` : undefined
}

function browserSubtitle(action: string, input: Record<string, unknown>, snapshot: string | undefined, t: Translate) {
  const element = quoted(snapshotElementName(snapshot, str(input.uid)))
  const key = (name: string) => `ui.tool.browser.${name}` as UiI18nKey
  switch (action) {
    case "openPage": {
      const type = str(input.type)
      if (type === "reload" || type === "back" || type === "forward") return t(key(type))
      return t(key("openPage"), { target: friendlyUrl(input.url) ?? "" }).trim()
    }
    case "click":
      return element ? t(key("click"), { target: element }) : t(key("clickBare"))
    case "fillField":
      return t(key("fillField"), { target: element ?? "" }).trim()
    case "pressKey":
      return str(input.key) ? t(key("pressKey"), { target: str(input.key)! }) : t(key("pressKeyBare"))
    default:
      return t(key(action))
  }
}

/**
 * The text the user sees for a tool: never the technical name, never the parameters.
 * `active` is true while it works (present tense) and false when it is done (past tense).
 * `snapshot` is the last browser snapshot, used to name the clicked elements.
 */
export function toolLabel(
  args: { tool: string; input?: Record<string, unknown>; active: boolean; snapshot?: string },
  t: Translate,
): ToolLabel {
  const input = args.input ?? {}
  const browserTool = args.tool.startsWith(BROWSER_PREFIX)
  const kind: Kind = browserTool ? "browser" : (KINDS[args.tool] ?? "generic")
  const title = t(`ui.tool.label.${kind}.${args.active ? "active" : "done"}` as UiI18nKey)

  switch (kind) {
    case "read":
    case "write":
    case "edit":
      return { title, subtitle: fileName(input.filePath) }
    case "document":
      return { title, subtitle: fileName(input.file) }
    case "shell":
      return { title, subtitle: shellSummary(input) }
    case "websearch":
    case "images":
      return { title, subtitle: str(input.query) }
    case "webfetch":
      return { title, subtitle: friendlyUrl(input.url) }
    case "task":
      return { title, subtitle: str(input.description) }
    case "skill":
      return { title, subtitle: skillName(input.name) }
    case "browser": {
      const action = BROWSER_ACTIONS[args.tool.slice(BROWSER_PREFIX.length)]
      return { title, subtitle: action ? browserSubtitle(action, input, args.snapshot, t) : undefined }
    }
    default:
      return { title }
  }
}

/** A message in plain words for a technical tool error; the real text stays in the detail. */
export function toolErrorMessage(tool: string, error: string, t: Translate) {
  if (/-32001|timed? ?out|timeout/i.test(error)) {
    return t(tool.startsWith(BROWSER_PREFIX) ? "ui.toolError.browserTimeout" : "ui.toolError.timeout")
  }
  if (tool === "edit" && /oldString|could not find|multiple matches/i.test(error)) return t("ui.toolError.editNotFound")
  if (/file not found|ENOENT|no such file/i.test(error)) return t("ui.toolError.fileNotFound")
  if (/rejected permission|permission denied|not allowed|denied/i.test(error)) return t("ui.toolError.denied")
  return t("ui.toolErrorCard.failed")
}
