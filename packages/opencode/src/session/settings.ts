// mango-code: what goes into the prompt is a setting. Every item (base tool, MCP server, skill, instructions file,
// plugin) is on or off; a missing item is on. Two files with the same format:
//   - the default one, in Mango Code's data (`MANGO_SETTINGS`, written by the app), applies to every folder;
//   - `.mango/settings.json` in the working folder, optional: changes only the items it contains and wins.
//   { "prompt": { "tools": {"webfetch": false}, "mcp": {"web-search": false}, "skills": {}, "instructions": {}, "plugins": {} } }
// They are read again at every request: a change applies from the next message. Nobody creates the folder file by
// itself: `write` does it when "only for this folder" is chosen on the settings page.

import fs from "node:fs"
import path from "node:path"
import { tr } from "@/util/mango-language"

export const KINDS = ["tools", "mcp", "skills", "instructions", "plugins"] as const
export type Kind = (typeof KINDS)[number]
export type Scope = "all" | "folder"
export type Sections = Partial<Record<Kind, Record<string, boolean>>>
export type Valid = { defaults: Sections; folder: Sections }

export const folderFile = (directory: string) => path.join(directory, ".mango", "settings.json")
/** The file for all folders; there is none if the agent was not started by Mango Code. */
export const defaultFile = () => process.env.MANGO_SETTINGS || undefined

const isKind = (name: string): name is Kind => (KINDS as readonly string[]).includes(name)
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

/** The JSON of the file, or `{}` if there is no file. A file that exists and cannot be read stops with its name. */
function readRaw(file: string): Record<string, unknown> {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw e
  }
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ""))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(tr(`${file} non e' JSON valido: ${reason}`, `${file} is not valid JSON: ${reason}`))
  }
  if (!isObject(json)) throw new Error(tr(`${file}: deve essere un oggetto JSON`, `${file}: must be a JSON object`))
  return json
}

function sections(file: string, json: Record<string, unknown>): Sections {
  const prompt = json.prompt
  if (prompt === undefined) return {}
  if (!isObject(prompt)) throw new Error(tr(`${file}: «prompt» deve essere un oggetto`, `${file}: "prompt" must be an object`))
  const out: Sections = {}
  for (const [kind, items] of Object.entries(prompt)) {
    if (!isKind(kind))
      throw new Error(
        tr(
          `${file}: «${kind}» non e' una sezione di prompt (${KINDS.join(", ")})`,
          `${file}: "${kind}" is not a prompt section (${KINDS.join(", ")})`,
        ),
      )
    if (!isObject(items)) throw new Error(tr(`${file}: «${kind}» deve essere un oggetto`, `${file}: "${kind}" must be an object`))
    for (const [name, on] of Object.entries(items)) {
      if (typeof on !== "boolean")
        throw new Error(tr(`${file}: ${kind}.${name} deve essere true o false`, `${file}: ${kind}.${name} must be true or false`))
    }
    out[kind] = items as Record<string, boolean>
  }
  return out
}

const read = (file: string | undefined): Sections => (file ? sections(file, readRaw(file)) : {})

/** The valid settings for a working folder. */
export function load(directory: string): Valid {
  return { defaults: read(defaultFile()), folder: read(folderFile(directory)) }
}

export function enabled(valid: Valid, kind: Kind, name: string): boolean {
  return valid.folder[kind]?.[name] ?? valid.defaults[kind]?.[name] ?? true
}

/** Which file the value of an item comes from: the folder file if it names it, else the default. */
export function source(valid: Valid, kind: Kind, name: string): "default" | "folder" {
  return name in (valid.folder[kind] ?? {}) ? "folder" : "default"
}

/**
 * Changes an item, for all folders or only for the working one. Only the items that differ from what would apply
 * without them are written: in the default file the disabled ones, in the folder file the ones that differ from the
 * default.
 */
export function write(directory: string, scope: Scope, kind: Kind, name: string, value: boolean) {
  const file = scope === "all" ? defaultFile() : folderFile(directory)
  if (!file)
    throw new Error(
      tr(
        "manca MANGO_SETTINGS: l'agente non e' stato avviato da Mango Code, non c'e' un file per tutte le cartelle",
        "MANGO_SETTINGS is missing: the agent was not started by Mango Code, there is no file for all folders",
      ),
    )
  const valid = load(directory)
  const json = readRaw(file)
  const prompt = isObject(json.prompt) ? { ...json.prompt } : {}
  const items = { ...(prompt[kind] as Record<string, boolean> | undefined) }
  const without = scope === "all" ? true : (valid.defaults[kind]?.[name] ?? true)
  if (value === without) delete items[name]
  else items[name] = value
  if (Object.keys(items).length) prompt[kind] = items
  else delete prompt[kind]
  json.prompt = prompt
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(json, null, 2) + "\n")
  fs.renameSync(temporary, file)
}

const PREFIX = "Instructions from: "

/** The file (or address) of a system text that carries the instructions of a file; `undefined` for any other text. */
export function instructionsFile(text: string): string | undefined {
  if (!text.startsWith(PREFIX)) return undefined
  const end = text.indexOf("\n")
  return text.slice(PREFIX.length, end < 0 ? undefined : end)
}

/**
 * How an instructions file is named among the items: the path inside the working folder; the bare name if it is
 * Mango Code's (it sits in an `opencode-home` folder); otherwise the full path (an app's extra folders).
 */
export function instructionName(file: string, directory: string): string {
  if (/^https?:\/\//.test(file)) return file
  const relative = path.relative(directory, file)
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replaceAll("\\", "/")
  if (path.basename(path.dirname(file)) === "opencode-home") return path.basename(file)
  return file.replaceAll("\\", "/")
}

/** How a plugin is named among the items: the file name without extension (`mango-discipline`), or its address. */
export function pluginName(spec: string): string {
  if (!spec.startsWith("file://")) return spec
  const name = decodeURIComponent(new URL(spec).pathname).split("/").pop() ?? spec
  return name.replace(/\.[cm]?[jt]s$/, "")
}

export * as PromptSettings from "./settings"
