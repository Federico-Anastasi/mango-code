// mango-code: what goes into the prompt is a setting, for each harness (session/harness.ts). Every item (base tool,
// MCP server, skill, instructions file, plugin, hook) is on or off; a missing item is on, a missing hook is as its
// harness has it. Two files with the same format:
//   - the default one, in Mango Code's data (`MANGO_SETTINGS`, written by the app), applies to every folder;
//   - `.mango/settings.json` in the working folder, optional: changes only the items it contains and wins.
//   { "prompt": { "tools": {"webfetch": false}, "mcp": {"web-search": false}, "skills": {}, "instructions": {}, "plugins": {}, "hooks": {} },
//     "harnesses": { "<harness>": { "prompt": { ... } } } }
// `prompt` holds the items of the default harness, `harnesses.<name>.prompt` those of each other one.
// They are read again at every request: a change applies from the next message. Nobody creates the folder file by
// itself: `write` does it when "only for this folder" is chosen on the settings page.

import fs from "node:fs"
import path from "node:path"
import { tr } from "@/util/mango-language"
import { DEFAULT } from "./harness"

export const KINDS = ["tools", "mcp", "skills", "instructions", "plugins", "hooks"] as const
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
    throw new Error(tr(`${file} non è JSON valido: ${reason}`, `${file} is not valid JSON: ${reason}`))
  }
  if (!isObject(json)) throw new Error(tr(`${file}: deve essere un oggetto JSON`, `${file}: must be a JSON object`))
  return json
}

/** Where a harness's items are in a settings file: at the top for the default harness, else under its name. */
function holder(file: string, json: Record<string, unknown>, harness: string): Record<string, unknown> | undefined {
  if (harness === DEFAULT) return json
  const all = json.harnesses
  if (all === undefined) return undefined
  if (!isObject(all)) throw new Error(tr(`${file}: «harnesses» deve essere un oggetto`, `${file}: "harnesses" must be an object`))
  const own = all[harness]
  if (own === undefined) return undefined
  if (!isObject(own))
    throw new Error(tr(`${file}: harnesses.${harness} deve essere un oggetto`, `${file}: harnesses.${harness} must be an object`))
  return own
}

function sections(file: string, json: Record<string, unknown>, harness: string): Sections {
  const prompt = holder(file, json, harness)?.prompt
  if (prompt === undefined) return {}
  if (!isObject(prompt)) throw new Error(tr(`${file}: «prompt» deve essere un oggetto`, `${file}: "prompt" must be an object`))
  const out: Sections = {}
  for (const [kind, items] of Object.entries(prompt)) {
    if (!isKind(kind))
      throw new Error(
        tr(
          `${file}: «${kind}» non è una sezione di prompt (${KINDS.join(", ")})`,
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

const read = (file: string | undefined, harness: string): Sections =>
  file ? sections(file, readRaw(file), harness) : {}

/** The valid settings of a harness for a working folder. */
export function load(directory: string, harness: string = DEFAULT): Valid {
  return { defaults: read(defaultFile(), harness), folder: read(folderFile(directory), harness) }
}

/** What the files say of an item, `undefined` if they do not name it: a hook is then as its harness has it. */
export function chosen(valid: Valid, kind: Kind, name: string): boolean | undefined {
  return valid.folder[kind]?.[name] ?? valid.defaults[kind]?.[name]
}

export function enabled(valid: Valid, kind: Kind, name: string): boolean {
  return chosen(valid, kind, name) ?? true
}

/** Which file the value of an item comes from: the folder file if it names it, else the default. */
export function source(valid: Valid, kind: Kind, name: string): "default" | "folder" {
  return name in (valid.folder[kind] ?? {}) ? "folder" : "default"
}

/**
 * Changes an item, for all folders or only for the working one. Only the items that differ from what would apply
 * without them are written: in the default file the disabled ones, in the folder file the ones that differ from the
 * default. A hook is always written: what applies without it is its harness's, which this file does not know.
 */
export function write(directory: string, scope: Scope, kind: Kind, name: string, value: boolean, harness: string = DEFAULT) {
  const file = scope === "all" ? defaultFile() : folderFile(directory)
  if (!file)
    throw new Error(
      tr(
        "manca MANGO_SETTINGS: l'agente non è stato avviato da Mango Code, non c'è un file per tutte le cartelle",
        "MANGO_SETTINGS is missing: the agent was not started by Mango Code, there is no file for all folders",
      ),
    )
  const valid = load(directory, harness)
  const json = readRaw(file)
  const own = holder(file, json, harness) ?? {}
  const prompt = isObject(own.prompt) ? { ...own.prompt } : {}
  const items = { ...(prompt[kind] as Record<string, boolean> | undefined) }
  const without =
    kind === "hooks"
      ? scope === "folder"
        ? valid.defaults.hooks?.[name]
        : undefined
      : scope === "all"
        ? true
        : (valid.defaults[kind]?.[name] ?? true)
  if (value === without) delete items[name]
  else items[name] = value
  if (Object.keys(items).length) prompt[kind] = items
  else delete prompt[kind]
  if (harness === DEFAULT) json.prompt = prompt
  else json.harnesses = { ...(isObject(json.harnesses) ? json.harnesses : {}), [harness]: { ...own, prompt } }
  save(file, json)
}

function save(file: string, json: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(json, null, 2) + "\n")
  fs.renameSync(temporary, file)
}

/** A harness was removed: its items leave the file for all folders, so that a new harness given its name starts with
 *  every item as it comes. The folders' own files are not known here and keep theirs. */
export function forget(harness: string) {
  const file = defaultFile()
  if (!file) return
  const json = readRaw(file)
  const all = json.harnesses
  if (!isObject(all) || !Object.hasOwn(all, harness)) return
  const { [harness]: _gone, ...rest } = all
  if (Object.keys(rest).length) json.harnesses = rest
  else delete json.harnesses
  save(file, json)
}

const PREFIX = "Instructions from: "

/** The file (or address) of a system text that carries the instructions of a file; `undefined` for any other text. */
export function instructionsFile(text: string): string | undefined {
  if (!text.startsWith(PREFIX)) return undefined
  const end = text.indexOf("\n")
  return text.slice(PREFIX.length, end < 0 ? undefined : end)
}

const within = (folder: string, file: string) => {
  const relative = path.relative(folder, file)
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)
}

/**
 * How an instructions file is named, in the request and among the items: its place from the working folder when it is in
 * that folder or in one above it (a project's own context), otherwise the bare file name. A place on the disk shown to the
 * model is a path it opens and writes, and the files outside the project are the app's own.
 */
export function instructionName(file: string, directory: string): string {
  if (/^https?:\/\//.test(file)) return file
  if (!within(directory, file) && !within(path.dirname(file), directory)) return path.basename(file)
  return path.relative(directory, file).replaceAll("\\", "/")
}

/** How a plugin is named among the items: the file name without extension (`mango-discipline`), or its address. */
export function pluginName(spec: string): string {
  if (!spec.startsWith("file://")) return spec
  const name = decodeURIComponent(new URL(spec).pathname).split("/").pop() ?? spec
  return name.replace(/\.[cm]?[jt]s$/, "")
}

export * as PromptSettings from "./settings"
