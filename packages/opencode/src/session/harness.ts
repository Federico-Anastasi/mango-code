// mango-code: the harness of a model. A harness is what the model reads and what Mango Code does while it works: the
// base prompt, the tools and their descriptions, the hooks with their numbers and texts. It is a folder:
//   harness.json   { "name", "from"?, "kind"?, "hooks": { "<hook>": { "on", "every"?, "times"? } } }, and for a
//                  `commands` harness also "command", "core", "commands" and "terminal"?
//   hooks.md       one text per hook, under `## <name>`
//   compaction.md  the texts of the summary that keeps a long conversation within the context, under `## <name>`
//   prompt.md, tools.json, skills/<name>.md   only a `commands` harness: its prompt, its tools and its skills
// The fixed ones are built into the agent (`harness-fixed.ts`, from `launcher/harness/`); the user's own are in the
// app's data, next to `MANGO_SETTINGS` (`harness/<id>`), each made from a fixed one (`from`): what it does not say
// comes from that one.
// The app's choices say which harness each model uses (`choices.json`, `models.<key>.harness`); a model without one
// uses the default. The definitions are read once and read again when their folders or the choices change.

import fs from "node:fs"
import path from "node:path"
import { tr } from "@/util/mango-language"
import { FIXED, TEAM_ROLES, type Files } from "./harness-fixed"

export const DEFAULT = "mango-harness-1"

type HookNumber = "every" | "times"
type Kind = "opencode" | "commands"
const BOTH: readonly Kind[] = ["opencode", "commands"]
const COMMANDS: readonly Kind[] = ["commands"]
/** The hooks the code knows: the numbers each one takes, with the value it has where a harness does not give one, and
 *  the kinds of harness that can run it. The hooks of the commands live inside them, so only that kind runs them. */
export const HOOKS: Record<string, { numbers: Partial<Record<HookNumber, number>>; kinds: readonly Kind[] }> = {
  // Mango Harness 1
  "discipline-messages": { numbers: { every: 3 }, kinds: BOTH },
  "discipline-calls": { numbers: { every: 12 }, kinds: BOTH },
  // Mango Harness 2 (the commands of `mango-harness/`)
  "after-failed-call": { numbers: {}, kinds: COMMANDS },
  "same-call-again": { numbers: {}, kinds: COMMANDS },
  "outside-project": { numbers: {}, kinds: COMMANDS },
  "path-taken-from-project": { numbers: {}, kinds: COMMANDS },
  "after-page-written": { numbers: {}, kinds: COMMANDS },
  "every-calls": { numbers: { every: 8 }, kinds: COMMANDS },
  "plan-open-every-calls": { numbers: { every: 8 }, kinds: COMMANDS },
  "cd-in-terminal": { numbers: {}, kinds: COMMANDS },
  "file-named-otherwise": { numbers: {}, kinds: COMMANDS },
  "answer-without-opening": { numbers: {}, kinds: COMMANDS },
  "would-lose": { numbers: {}, kinds: COMMANDS },
  "web-in-terminal": { numbers: {}, kinds: COMMANDS },
  "web-before-own-tools": { numbers: {}, kinds: COMMANDS },
  "page-not-found": { numbers: {}, kinds: COMMANDS },
  "rules-in-messages": { numbers: {}, kinds: COMMANDS },
  "unreadable-call": { numbers: { times: 2 }, kinds: COMMANDS },
}

/** The texts of the summary (`compaction.md`): the instruction to the model, in the parts `compaction.ts` joins, and the
 *  lines the agent writes around the summary. */
export const COMPACTION_TEXTS = [
  "first",
  "update",
  "template",
  "rule",
  "continued",
  "files-read",
  "files-changed",
  "missing",
  "unwritten",
  "cut",
] as const

export type Hook = { on: boolean; every?: number; times?: number }
/** A tool of a `commands` harness as the model sees it; `answers` (what it gives back) is for people, not sent. */
export type Tool = { description: string; parameters: unknown; answers?: string }
export type Definition = {
  id: string
  name: string
  fixed: boolean
  /** `opencode`: the agent's own prompt, tools and plugins (Mango Harness 1). `commands`: its own prompt, tools and
   *  hooks (Mango Harness 2, `mango-harness/`). */
  kind: "opencode" | "commands"
  hooks: Record<string, Hook>
  texts: Record<string, string>
  /** The texts of the summary, by `COMPACTION_TEXTS`. */
  compaction: Record<string, string>
  /** Only `commands`: */
  prompt?: string
  tools?: Record<string, Tool>
  /** The skills, by name: the text of `skills/<name>.md` (a `desc:` line, an empty line, the body). */
  skills?: Record<string, string>
  /** The tool that opens a skill, the tools usable from the start, the choices of the commands. */
  command?: string
  core?: string[]
  commands?: Record<string, string | boolean>
  /** The shell of the tool `terminal`: Git Bash; PowerShell when it is not said. */
  terminal?: "bash"
}

type Raw = Omit<Definition, "id" | "fixed" | "hooks" | "kind"> & {
  from?: string
  kind?: Definition["kind"]
  hooks: Record<string, Partial<Hook>>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)


const dataDir = () => (process.env.MANGO_SETTINGS ? path.dirname(process.env.MANGO_SETTINGS) : undefined)
const ownDir = () => {
  const data = dataDir()
  return data ? path.join(data, "harness") : undefined
}
const isFixed = (id: string) => Object.hasOwn(FIXED, id)
/** The folder of a harness of the user's: only a name as `freeId` makes it, so that an id never leads out of it. */
const ownFolder = (id: string) => {
  const own = ownDir()
  return own && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ? path.join(own, id) : undefined
}
const notThere = (id: string) => new Error(tr(`l'harness «${id}» non c'è`, `the harness "${id}" is not there`))

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
}

/** `## name` sections of a hooks.md or compaction.md: the text under each heading that names one of `known`, without the
 *  blank lines around it. Any other `## ` line is part of the text it is in. */
export function sections(text: string, known: readonly string[] = Object.keys(HOOKS)): Record<string, string> {
  const out: Record<string, string> = {}
  let name: string | undefined
  let lines: string[] = []
  const close = () => {
    if (name !== undefined) out[name] = lines.join("\n").replace(/^\n+|\n+$/g, "")
  }
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^## (.+?)\s*$/.exec(line)?.[1]
    if (heading === undefined || !known.includes(heading)) {
      lines.push(line)
      continue
    }
    close()
    name = heading
    lines = []
  }
  close()
  return out
}

function readSkills(dir: string): Record<string, string> | undefined {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md"))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw e
  }
  return Object.fromEntries(names.map((name) => [name.slice(0, -3), readText(path.join(dir, name)) ?? ""]))
}

/** A folder of the user's harnesses; `undefined` if it has no harness.json. */
function readFolder(dir: string): Files | undefined {
  const json = (name: string) => {
    const file = path.join(dir, name)
    const text = readText(file)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text) as unknown
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      throw new Error(`${file}: ${tr(`non è JSON valido: ${reason}`, `is not valid JSON: ${reason}`)}`)
    }
  }
  const harness = json("harness.json")
  if (harness === undefined) return undefined
  return {
    harness,
    hooks: readText(path.join(dir, "hooks.md")),
    compaction: readText(path.join(dir, "compaction.md")),
    prompt: readText(path.join(dir, "prompt.md")),
    tools: json("tools.json"),
    skills: readSkills(path.join(dir, "skills")),
  }
}

/** `where`: how an error names the harness (its harness.json on the disk, or the name of a fixed one). */
function parse(files: Files, where: string): Raw {
  const fail = (it: string, en: string): never => {
    throw new Error(`${where}: ${tr(it, en)}`)
  }
  const json = files.harness
  if (!isObject(json)) return fail("deve essere un oggetto JSON", "must be a JSON object")
  if (typeof json.name !== "string" || !json.name.trim()) fail("manca «name»", `"name" is missing`)
  if (json.from !== undefined && typeof json.from !== "string") fail("«from» deve essere un testo", `"from" must be a text`)
  if (json.kind !== undefined && json.kind !== "opencode" && json.kind !== "commands")
    fail("«kind» è «opencode» o «commands»", `"kind" is "opencode" or "commands"`)
  const hooks = json.hooks ?? {}
  if (!isObject(hooks)) return fail("«hooks» deve essere un oggetto", `"hooks" must be an object`)
  for (const [name, hook] of Object.entries(hooks)) {
    const numbers = Object.hasOwn(HOOKS, name) && Object.keys(HOOKS[name].numbers)
    if (!numbers) return fail(`«${name}» non è un gancio di Mango Code`, `"${name}" is not a hook of Mango Code`)
    if (!isObject(hook)) return fail(`hooks.${name} deve essere un oggetto`, `hooks.${name} must be an object`)
    if (hook.on !== undefined && typeof hook.on !== "boolean")
      fail(`hooks.${name}.on deve essere true o false`, `hooks.${name}.on must be true or false`)
    for (const [key, value] of Object.entries(hook)) {
      if (key === "on") continue
      if (!numbers.includes(key as HookNumber))
        fail(`hooks.${name}: «${key}» non è un numero di questo gancio`, `hooks.${name}: "${key}" is not a number of this hook`)
      if (!Number.isInteger(value) || (value as number) < 1)
        fail(`hooks.${name}.${key} deve essere un intero da 1 in su`, `hooks.${name}.${key} must be a whole number, 1 or more`)
    }
  }
  if (files.tools !== undefined && !isObject(files.tools)) fail("tools.json deve essere un oggetto", "tools.json must be an object")
  if (json.terminal !== undefined && json.terminal !== "bash")
    fail("«terminal» è «bash», o non c'è", `"terminal" is "bash", or it is left out`)
  return {
    name: json.name as string,
    from: json.from as string | undefined,
    kind: json.kind as Definition["kind"] | undefined,
    hooks: hooks as Record<string, Partial<Hook>>,
    texts: sections(files.hooks ?? ""),
    compaction: sections(files.compaction ?? "", COMPACTION_TEXTS),
    prompt: files.prompt,
    tools: files.tools as Record<string, Tool> | undefined,
    skills: files.skills,
    command: json.command as string | undefined,
    core: json.core as string[] | undefined,
    commands: json.commands as Record<string, string | boolean> | undefined,
    terminal: json.terminal as "bash" | undefined,
  }
}

/** The texts of every hook as the harnesses of Mango Code have them: a hook turned on in a harness that does not
 *  bring its text says what its own harness says. */
const hookTexts = () => Object.assign({}, ...Object.values(FIXED).map((files) => sections(files.hooks ?? ""))) as Record<string, string>

/** The definition with the switches of the settings page over it (`chosen`: what they say of a hook, `undefined` if
 *  nothing): every hook its kind can run, on or off, with its numbers. */
export function withSwitches(definition: Definition, chosen: (hook: string) => boolean | undefined): Definition {
  const hooks = Object.entries(HOOKS).flatMap(([name, known]): [string, Hook][] => {
    if (!known.kinds.includes(definition.kind)) return []
    const own = definition.hooks[name]
    const on = chosen(name) ?? own?.on ?? false
    return own || on ? [[name, { ...known.numbers, ...own, on }]] : []
  })
  return { ...definition, hooks: Object.fromEntries(hooks) }
}

function build(id: string): Definition {
  const fixed = isFixed(id)
  const folder = fixed ? undefined : ownFolder(id)
  const files = fixed ? FIXED[id] : folder ? readFolder(folder) : undefined
  if (!files) throw notThere(id)
  return assemble(id, files, folder ? path.join(folder, "harness.json") : id)
}

/** A definition from the files of its folder; `where` is how an error names it. */
function assemble(id: string, files: Files, where: string): Definition {
  const fixed = isFixed(id)
  const raw = parse(files, where)
  const { from, hooks: rawHooks, ...rest } = raw
  const runnable = (kind: Kind) => {
    const foreign = Object.keys(rawHooks).find((name) => !HOOKS[name].kinds.includes(kind))
    if (foreign)
      throw new Error(
        `${where}: ${tr(`il gancio «${foreign}» non gira in un harness di questo tipo`, `the hook "${foreign}" does not run in a harness of this kind`)}`,
      )
  }
  if (fixed) {
    const kind = raw.kind ?? "opencode"
    runnable(kind)
    const hooks = Object.fromEntries(Object.entries(rawHooks).map(([name, hook]) => [name, { on: true, ...hook } as Hook]))
    const lacking = COMPACTION_TEXTS.filter((name) => !raw.compaction[name]?.trim())
    if (lacking.length)
      throw new Error(`${where}: ${tr(`compaction.md non ha: ${lacking.join(", ")}`, `compaction.md lacks: ${lacking.join(", ")}`)}`)
    return { ...rest, id, fixed, kind, hooks, texts: { ...hookTexts(), ...raw.texts } }
  }
  if (!from || !isFixed(from))
    throw new Error(
      tr(
        `l'harness «${id}» deve dire da quale harness di Mango Code nasce («from»: ${Object.keys(FIXED).join(", ")})`,
        `the harness "${id}" must say which harness of Mango Code it was made from ("from": ${Object.keys(FIXED).join(", ")})`,
      ),
    )
  const base = definition(from)
  runnable(base.kind)
  const hooks = { ...base.hooks }
  for (const [name, hook] of Object.entries(rawHooks)) hooks[name] = { ...(base.hooks[name] ?? { on: true, ...HOOKS[name].numbers }), ...hook }
  // A tool of the user's harness changes only what it says: its description, not the parameters the code reads. Made
  // from a harness that brings no tools, it describes the agent's own (`describe`).
  const tools = base.tools
    ? Object.fromEntries(
        Object.entries(base.tools).map(([name, tool]) => [
          name,
          raw.tools?.[name]?.description === undefined ? tool : { ...tool, description: raw.tools[name].description },
        ]),
      )
    : raw.tools
  return {
    ...base,
    id,
    name: raw.name,
    fixed,
    hooks,
    texts: { ...base.texts, ...raw.texts },
    compaction: { ...base.compaction, ...raw.compaction },
    prompt: raw.prompt ?? base.prompt,
    tools,
    skills: base.skills || raw.skills ? { ...base.skills, ...raw.skills } : undefined,
  }
}

let cache = new Map<string, Definition>()
let models: Record<string, string> | undefined
let watchers: fs.FSWatcher[] = []

/** Forgets what was read: the next request reads the folders and the settings again. */
export function forget() {
  cache = new Map()
  models = undefined
}

let watchingData = false
let watchingOwn = false

function arm(dir: string, recursive: boolean) {
  try {
    watchers.push(fs.watch(dir, { recursive }, () => forget()))
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    return false
  }
}

/** The folder of the user's harnesses is watched from when it exists: Duplica makes it. */
function watchOwn() {
  const own = ownDir()
  if (watchingOwn || !own) return
  watchingOwn = arm(own, true)
}

// The definitions and the settings change only when the app or the user writes them: a watcher forgets what was read.
// A folder that does not exist yet is tried again at the next request, and what was read before it is read again.
function watch() {
  if (watchingData) return
  const data = dataDir()
  if (data && !arm(data, false)) return
  watchingData = true
  forget()
  watchOwn()
}

/** Only for tests: stops watching the folders of the previous run. */
export function unwatch() {
  for (const w of watchers) w.close()
  watchers = []
  watchingData = false
  watchingOwn = false
}

/** The prompt of a harness as written, with its placeholders. */
export function promptText(definition: Definition): string {
  if (definition.prompt === undefined) throw new Error(tr(`l'harness «${definition.id}» non ha un prompt`, `the harness "${definition.id}" has no prompt`))
  return definition.prompt
}

/** The prompt the model reads in a harness that runs the agent's own loop. What the app knows goes where the prompt has
 *  a line `{{programs}}` (what is installed on this PC, from the app) or `{{role}}` (the instructions of a hidden process
 *  of the Team); a line without a value is left out. */
export function basePrompt(definition: Definition): string {
  const role = TEAM_ROLES[process.env.MANGO_TEAM_ROLE ?? ""]
  const values: Record<string, string | undefined> = {
    // a blank line after the role, as between any two instructions
    role: role && `${role}\n`,
    programs: process.env.MANGO_PC_PROGRAMS,
  }
  return promptText(definition).replace(/^\{\{(role|programs)\}\}\n/gm, (_, name: string) => values[name] ?? "")
}

export function definition(id: string): Definition {
  const known = cache.get(id)
  if (known) return known
  const made = build(id)
  cache.set(id, made)
  return made
}

// The app writes the choices and checks them (`engine-cfg`, choices.rs): here they are only read.
function modelHarnesses(): Record<string, string> {
  if (models) return models
  const data = dataDir()
  const text = data ? readText(path.join(data, "choices.json")) : undefined
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  const chosen = isObject(json.models) ? json.models : {}
  models = Object.fromEntries(
    Object.entries(chosen).flatMap(([key, choices]) =>
      isObject(choices) && typeof choices.harness === "string" ? [[key, choices.harness]] : [],
    ),
  )
  return models
}

/** The harness of a model: the one chosen for it in the app, by its catalog key; a model of another provider (an external
 *  server's, `server-<n>`) is not in the catalog, also when its name is a catalog key's, and has the default one. */
export function forModel(modelID: string, providerID = "mango"): Definition {
  watch()
  return definition((providerID.startsWith("server-") ? undefined : modelHarnesses()[modelID]) ?? DEFAULT)
}

const sessions = new Map<string, { modelID: string; providerID: string }>()

/** The model of a conversation's request: from then on its hooks follow that model's harness. */
export function bind(sessionID: string, modelID: string, providerID: string) {
  sessions.set(sessionID, { modelID, providerID })
}

/** The conversation is gone. */
export function unbind(sessionID: string) {
  sessions.delete(sessionID)
}

export function ofSession(sessionID: string): Definition {
  const model = sessions.get(sessionID)
  if (model !== undefined) return forModel(model.modelID, model.providerID)
  watch()
  return definition(DEFAULT)
}

/** The tools of a request with the words this harness gives them: a harness of the user's can describe the agent's
 *  tools its own way; the others are as the agent has them. */
export function describe<T extends { description?: string }>(definition: Definition, tools: Record<string, T>): Record<string, T> {
  const own = definition.tools
  if (!own) return tools
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [name, own[name] ? { ...tool, description: own[name].description } : tool]),
  )
}

export type Listed = { id: string; name: string; fixed: boolean; kind?: Kind; from?: string; error?: string }

/** The harnesses there are: Mango Code's, then the user's, by name. One the agent cannot read is listed with why. */
export function list(): Listed[] {
  const own = ownDir()
  let folders: string[] = []
  try {
    // a folder being written (`writeFolder`) or not named as Duplica names them is not a harness
    folders = own
      ? fs
          .readdirSync(own, { withFileTypes: true })
          .filter((e) => e.isDirectory() && ownFolder(e.name))
          .map((e) => e.name)
      : []
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
  }
  const entry = (id: string): Listed | undefined => {
    try {
      const made = definition(id)
      const from = made.fixed ? undefined : (readFolder(path.join(own!, id))?.harness as { from?: string } | undefined)?.from
      return { id, name: made.name, fixed: made.fixed, kind: made.kind, ...(from ? { from } : {}) }
    } catch (e) {
      if (!fs.existsSync(path.join(own ?? "", id, "harness.json"))) return undefined
      return { id, name: id, fixed: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  const mine = folders.flatMap((id) => entry(id) ?? []).sort((a, b) => a.name.localeCompare(b.name))
  return [...Object.keys(FIXED).map((id) => entry(id)!), ...mine]
}

const writable = (id: string) => {
  if (isFixed(id))
    throw new Error(
      tr(`«${id}» è un harness di Mango Code: duplicalo per cambiarlo`, `"${id}" is a harness of Mango Code: duplicate it to change it`),
    )
  if (!ownDir())
    throw new Error(
      tr("manca MANGO_SETTINGS: non c'è una cartella per gli harness", "MANGO_SETTINGS is missing: there is no folder for the harnesses"),
    )
  const folder = ownFolder(id)
  if (!folder) throw notThere(id)
  return folder
}

/** The text of a hooks.md or compaction.md, one section for each name. */
const sectionsFile = (texts: Record<string, string>) =>
  Object.entries(texts)
    .map(([name, text]) => `## ${name}\n${text}\n`)
    .join("\n")

/** Writes the files of a folder as a whole: into a new folder first, which then takes the place of the old one with two
 *  renames, so that a request in between hardly ever finds the harness missing. */
async function writeFolder(folder: string, files: Files) {
  const next = `${folder}.${process.pid}.new`
  const old = `${folder}.${process.pid}.old`
  await fs.promises.rm(next, { recursive: true, force: true })
  await fs.promises.mkdir(path.join(next, "skills"), { recursive: true })
  await fs.promises.writeFile(path.join(next, "harness.json"), JSON.stringify(files.harness, null, 2) + "\n")
  if (files.hooks !== undefined) await fs.promises.writeFile(path.join(next, "hooks.md"), files.hooks)
  if (files.compaction !== undefined) await fs.promises.writeFile(path.join(next, "compaction.md"), files.compaction)
  if (files.prompt !== undefined) await fs.promises.writeFile(path.join(next, "prompt.md"), files.prompt)
  if (files.tools !== undefined)
    await fs.promises.writeFile(path.join(next, "tools.json"), JSON.stringify(files.tools, null, 2) + "\n")
  for (const [name, text] of Object.entries(files.skills ?? {}))
    await fs.promises.writeFile(path.join(next, "skills", `${name}.md`), text)
  await fs.promises.rm(old, { recursive: true, force: true })
  const replaced = await fs.promises.rename(folder, old).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e
      return false
    },
  )
  await fs.promises.rename(next, folder)
  if (replaced) await fs.promises.rm(old, { recursive: true, force: true })
  forget()
  watchOwn()
}

/** A name for the folder of a new harness: its name in plain letters, numbered if taken. */
function freeId(name: string) {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "harness"
  const taken = new Set(list().map((h) => h.id))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** A new harness of the user's, copied from `source`: from one of Mango Code it says only that, from one of the
 *  user's it takes all its files. Gives the name of its folder. */
export async function duplicate(source: string, name: string): Promise<string> {
  if (!name.trim()) throw new Error(tr("manca il nome", "the name is missing"))
  const original = definition(source)
  const id = freeId(name)
  const folder = writable(id)
  const copied = original.fixed ? undefined : readFolder(writable(source))
  const files: Files = copied
    ? { ...copied, harness: { ...(copied.harness as object), name: name.trim() } }
    : { harness: { name: name.trim(), from: source } }
  await writeFolder(folder, files)
  return id
}

export type Change = {
  name?: string
  prompt?: string
  /** A tool's description, by name. */
  tools?: Record<string, string>
  hooks?: Record<string, { on?: boolean; every?: number; times?: number }>
  texts?: Record<string, string>
  /** A text of the summary, by `COMPACTION_TEXTS`. */
  compaction?: Record<string, string>
}

/** Changes a harness of the user's: only what `change` says. The new definition is checked before it is written. */
export async function update(id: string, change: Change) {
  const folder = writable(id)
  const files = readFolder(folder)
  if (!files) throw notThere(id)
  for (const [name, text] of Object.entries(change.compaction ?? {})) {
    if (!(COMPACTION_TEXTS as readonly string[]).includes(name))
      throw new Error(tr(`«${name}» non è un testo del riassunto`, `"${name}" is not a text of the summary`))
    if (!text.trim()) throw new Error(tr(`il testo «${name}» del riassunto è vuoto`, `the summary text "${name}" is empty`))
  }
  if (change.compaction?.missing !== undefined && !change.compaction.missing.includes("{{missing}}"))
    throw new Error(tr("il testo «missing» deve contenere {{missing}}", `the text "missing" must contain {{missing}}`))
  const json = files.harness as { name: string; from?: string; hooks?: Record<string, object> }
  const hooks = { ...json.hooks }
  // a hook the harness does not run yet comes in off: changing its text or its number does not turn it on
  const current = definition(id).hooks
  for (const [name, hook] of Object.entries(change.hooks ?? {}))
    hooks[name] = { ...(current[name] || hooks[name] ? {} : { on: false }), ...hooks[name], ...hook }
  const tools = { ...(files.tools as Record<string, { description: string }> | undefined) }
  for (const [name, description] of Object.entries(change.tools ?? {})) tools[name] = { description }
  const next: Files = {
    ...files,
    harness: {
      ...json,
      ...(change.name?.trim() ? { name: change.name.trim() } : {}),
      ...(Object.keys(hooks).length ? { hooks } : {}),
    },
    hooks: change.texts ? sectionsFile({ ...sections(files.hooks ?? ""), ...change.texts }) : files.hooks,
    compaction: change.compaction
      ? sectionsFile({ ...sections(files.compaction ?? "", COMPACTION_TEXTS), ...change.compaction })
      : files.compaction,
    prompt: change.prompt ?? files.prompt,
    tools: Object.keys(tools).length ? tools : undefined,
  }
  assemble(id, next, path.join(folder, "harness.json"))
  await writeFolder(folder, next)
}

/** Removes a harness of the user's that no model uses. */
export async function remove(id: string) {
  const folder = writable(id)
  if (!fs.existsSync(path.join(folder, "harness.json"))) throw notThere(id)
  // the choices as they are now, not as a watcher last saw them
  models = undefined
  const users = Object.entries(modelHarnesses())
    .filter(([, harness]) => harness === id)
    .map(([model]) => model)
  if (users.length)
    throw new Error(
      tr(
        `l'harness «${id}» è quello di ${users.join(", ")}: scegline un altro per loro, poi toglilo`,
        `the harness "${id}" is the one of ${users.join(", ")}: choose another one for them, then remove it`,
      ),
    )
  await fs.promises.rm(folder, { recursive: true, force: true })
  forget()
}

export * as Harness from "./harness"
