// The harness of a conversation: the commands a model can call and what the harness does around them. A harness
// (see version.ts) gives the names and the parameters of the commands, the texts of the hooks and the skills; this
// code gives the behaviour. A hook that the harness has is a behaviour that is on.
//
// One harness is opened for one conversation in one project folder:
//   system()        the system messages, with the user's own skills in the list of the harness's
//   message(text)   the user's message as the model receives it
//   call(name, a)   runs a command the model called and gives what it answers
//   answer()        before an answer is shown to the user: a text for the model if the answer is held back
//   close()         stops what the conversation left running
import fs from "node:fs/promises"
import path from "node:path"
import type { Answer, Browser, Page, Skill, User, Web } from "./contracts"
import {
  edit,
  escaped,
  fromProject,
  listing,
  located,
  missing,
  no,
  ok,
  place,
  read,
  search,
  within,
  write,
  type Files,
} from "./files"
import { LOOK_ANSWER, LOOK_HINT } from "./look"
import { described, keep, lostBetween, lostIn, restore, type Kept, type Lost } from "./loss"
import { goal, openSteps, parsePlan, parseStep, shownStep, titles, whole, type Plan } from "./plan"
import { elsewhere, fromBash, inFolder, movedBy, pathsIn, run, type Shell } from "./terminal"
import type { versionOf } from "./version"

type Version = ReturnType<typeof versionOf>
type Args = Record<string, unknown>
type Schema = { parameters: { properties: Record<string, { type: string; description?: string }>; required: string[] } }

/** The moments a harness can give a text for, and the values the code fills in each. */
const MOMENTS: [RegExp, string[]][] = [
  [/^same-call-again$/, []],
  [/^outside-project$/, ["path", "listing"]],
  [/^path-taken-from-project$/, ["path", "used"]],
  [/^after-failed-call$/, []],
  [/^every-\d+-calls$/, ["calls"]],
  [/^plan-open-every-\d+-calls$/, ["open_steps"]],
  [/^cd-in-terminal$/, ["listing"]],
  [/^after-page-written$/, []],
  [/^file-named-otherwise$/, ["path", "named"]],
  [/^answer-without-opening$/, []],
  [/^would-lose$/, ["what", "answer"]],
  [/^web-in-terminal$/, ["url"]],
  [/^web-before-own-tools$/, ["tools"]],
  [/^page-not-found$/, ["url", "back", "page"]],
]
/** A command of the terminal that fetches a page: what a model writes to read a site without a browser. */
const FETCHES =
  /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|requests|urllib|httpx|aiohttp|http\.client)\b/i
/** The commands of the terminal that may delete or write over files: only these are watched for what they lose. */
const RISKY =
  /\b(rm|del|erase|rd|rmdir|ri|remove-item|mv|move|mi|move-item|cp|copy|cpi|copy-item|xcopy|robocopy|ren|rename|rni|rename-item|clear-content|clc|set-content|sc|out-file|new-item|ni|tee|tee-object|git|find|sed|truncate|unlink|shred|rsync)\b|(^|[^2>&*])>(?!>)/i

/** Words of a request that order a file deleted, and words that order one written anew (with `told` in `commands`). */
const DELETING =
  /\b(cancella\w*|elimina\w*|togli\w*|rimuovi|rimuov\w*|butta\w*|delete\w*|remove\w*|erase\w*|get rid)\b/i
const REWRITING =
  /\b(riscriv\w*|sovrascriv\w*|sostituisci tutto|sostituisci il contenuto|nuovo di zecca|nuova di zecca|da capo|da zero|rewrite\w*|overwrite\w*|from scratch|replace (all|the whole|everything))\b/i

const DEFAULT_SECONDS = 120
const MOST_SECONDS = 600

const URLS = /https?:\/\/[^\s<>"'`\]]+/g
/** The names of files in a message: in quotes, or as one word with an extension outside the quotes. */
const QUOTED = /[«"`]([^«»"`\n]+\.[\p{L}\p{N}]{1,5})[»"`]/gu
const BARE =
  /(?<=^|[\s(])((?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.\p{L}[\p{L}\p{N}]{0,4})(?=$|[\s,;:!?)»"'.])/gu
/** What a hook adds to the answer of a command is set apart from it, so that it is not taken for the file or the
 *  program's own output. */
const aside = (text: string) => `<system-reminder>\n${text}\n</system-reminder>`
// An address ends where the sentence around it goes on: a full stop, or a bracket that the address never opened.
const address = (url: string) =>
  url
    .replace(/#.*$/, "")
    .replace(/[.,;:!?]+$/, "")
    .replace(/\)+$/, (closing) => (url.includes("(") ? closing : ""))
    .replace(/\/$/, "")
    .toLowerCase()

function shownPage(page: Page, sight = false) {
  const lines = page.items.map((item, i) =>
    "text" in item
      ? item.text
      : `[${page.items.slice(0, i + 1).filter((other) => "control" in other).length}] ${item.control}: ${item.label}`,
  )
  return `${[page.title, ...lines].filter(Boolean).join("\n")}\n\n${page.errors.length ? `Errors of the console:\n${page.errors.join("\n")}` : "No errors in the console"}${sight && page.unseen ? `\n\n${LOOK_HINT}` : ""}`
}

export function openHarness(options: {
  project: string
  version: Version
  web: Web
  browser: Browser
  user: User
  skills?: Skill[]
  /** Tools of the user's own, declared next to the commands: each answers its text. */
  tools?: { name: string; description: string; answers: string }[]
  env?: Record<string, string | undefined>
}) {
  const version = options.version
  const project = path.resolve(options.project)
  const commands = version.meta.commands
  if (!commands) throw new Error(`the version ${version.name} has no \`commands\``)
  const schemas = new Map<string, Schema>(Object.entries(version.toolsFile() as Record<string, Schema>))
  const own = options.skills ?? []
  const pages = new Map([
    ...[...version.pages].map(([name, page]): [string, string] => [name, page.body]),
    ...own.map((skill): [string, string] => [skill.name, skill.body]),
  ])
  const skills = [...pages.keys()].sort()

  for (const [moment, text] of version.hooks) {
    const known = MOMENTS.find(([name]) => name.test(moment))
    if (!known) throw new Error(`the hooks of ${version.name} have a moment the harness does not know: ${moment}`)
    for (const [value, skill, key] of text.matchAll(/\{\{(?:skill ([a-z0-9-]+)|(\w+))\}\}/g)) {
      if (skill ? !pages.has(skill) : !known[1].includes(key))
        throw new Error(`the hooks of ${version.name}, ${moment}: the harness has nothing to put in ${value}`)
    }
  }
  if (!version.hooks.has("outside-project"))
    throw new Error(`the hooks of ${version.name} need the moment outside-project`)
  const numberOf = (pattern: RegExp) => {
    const moment = [...version.hooks.keys()].find((name) => pattern.test(name))
    return moment ? { moment, every: Number(moment.match(/\d+/)?.[0]) } : undefined
  }
  const everyCalls = numberOf(/^every-\d+-calls$/)
  const planEveryCalls = numberOf(/^plan-open-every-\d+-calls$/)

  const state = {
    calls: 0,
    messages: 0,
    last: undefined as { key: string; failed: boolean } | undefined,
    plan: undefined as Plan | undefined,
    page: undefined as Page | undefined,
    web: { results: false, opened: false, held: false },
    taken: [] as string[],
    said: [] as string[],
    named: new Set<string>(),
    known: new Set<string>(),
    given: undefined as Kept | undefined,
    asked: false,
    warned: new Set<string>(),
    /** A tool of the user's was called, or the list of them was given once before the web. */
    toolsUsed: false,
  }
  const tools = new Map((options.tools ?? []).map((tool) => [tool.name, tool]))
  const origin = (url: string) => URL.parse(url)?.origin.toLowerCase()
  /** The first address of a page the user gave or a search found that the command fetches. */
  const fetchedPage = (command: string) =>
    FETCHES.test(command)
      ? (command.match(URLS) ?? []).find((url) => [...state.known].some((known) => origin(known) === origin(url)))
      : undefined
  const skill = (name: string) => version.fill(pages.get(name) ?? "", project)
  const say = (moment: string, values: Record<string, string> = {}) =>
    (version.hooks.get(moment) ?? "").replace(
      /\{\{(?:skill ([a-z0-9-]+)|(\w+))\}\}/g,
      (_, name: string | undefined, key: string) => (name ? skill(name) : values[key]),
    )
  const has = (moment: string) => version.hooks.has(moment)
  // A command that would lose files of the user's is not done: the harness asks the user, as an application asks for
  // a permission, and gives the model the answer. Once the user has been asked, by the model or by the harness, or
  // has spoken again, the conversation is theirs to decide and nothing more is held.
  const watching = () => has("would-lose") && !state.asked
  /** The request orders this loss: it names the file, by name, by name without extension or by extension alone, in a
   *  message that says to delete it (a file deleted) or to write it anew (a file written over). */
  const told = (one: Lost) => {
    const file = one.shown.split("/").at(-1)?.toLowerCase() ?? ""
    const dot = file.lastIndexOf(".")
    // A name without its extension counts from three letters: `a` of `a.txt` is a word of any sentence.
    const names = [file, ...(dot >= 3 ? [file.slice(0, dot)] : [])].map(escaped)
    const kind = dot > 0 ? [`\\*?${escaped(file.slice(dot))}`] : []
    const named = new RegExp(`(^|[^\\p{L}\\p{N}_.-])(${[...names, ...kind].join("|")})(?=$|[^\\p{L}\\p{N}_-])`, "u")
    return state.said.some((text) => (one.removed ? DELETING : REWRITING).test(text) && named.test(text))
  }
  /** What the model is told instead of the command, or undefined if nothing new would be lost. */
  const held = async (lost: Lost[]) => {
    const asking = commands.told ? lost.filter((one) => !told(one)) : lost
    const fresh = asking.filter((one) => !state.warned.has(one.shown.toLowerCase()))
    if (!fresh.length) return undefined
    asking.forEach((one) => state.warned.add(one.shown.toLowerCase()))
    state.asked = true
    const what = described(asking)
    const answer = await options.user(`This would lose:\n${what}\nGo ahead?`, [], "harness")
    // Not a failure of the model's: the command was right, the harness only stopped it to ask.
    return { ...ok(say("would-lose", { what, answer })), again: true as const }
  }
  const notice = (text: string) => (text.match(URLS) ?? []).forEach((url) => state.known.add(address(url)))
  // A small model writes the paths of the computers it was trained on. Where the harness says so, such a path is
  // taken from the project folder and the answer says it, instead of being refused as a place outside.
  const local = async (written: string) => {
    const used = has("path-taken-from-project") ? await fromProject(project, written) : undefined
    if (used === undefined) return written
    state.taken.push(aside(say("path-taken-from-project", { path: written, used })))
    return used
  }

  // Reading is free, except the root of the drive (also with a wildcard: `/*`), which no command may name. Writing
  // outside the project needs a reason: the user named that place, or a folder above it that is not above the
  // project too.
  const reach = (whole: string, how: "read" | "write") => {
    const parent = path.dirname(whole)
    if (parent === whole || (parent === path.parse(whole).root && /[*?]/.test(path.basename(whole)))) return false
    if (how === "read") return true
    const above = whole.split(path.sep).map((_, i, parts) =>
      parts
        .slice(0, parts.length - i)
        .join(path.sep)
        .toLowerCase(),
    )
    return above.some(
      (folder) => folder.length > 3 && !within(project, folder) && state.said.some((text) => text.includes(folder)),
    )
  }
  const files: Files = {
    reach,
    project,
    commands,
    vision: version.vision,
    outside: async (given) => no(say("outside-project", { path: given, listing: await listing(project) })),
  }
  const view = async (target: string) => {
    const back = state.page?.address
    const page = await options.browser.view(target)
    // The browser has no way out to the web: a page that a search found is read with the command made for it.
    const searched = schemas.has("web_open") && state.known.has(address(target))
    if (page instanceof Error)
      return no(
        `The page could not be opened: ${page.message}${searched ? " A page that a web search found opens with `web_open`." : ""}`,
      )
    if (/^https?:\/\//i.test(target)) state.web.opened = true
    // An address made up on the site of the page that was open: that page again, with the links it really has.
    if (has("page-not-found") && page.status === 404 && back && origin(back) === origin(page.address ?? target)) {
      const again = await options.browser.back()
      if (!(again instanceof Error)) {
        state.page = again
        return no(
          say("page-not-found", { url: target, back: again.address ?? back, page: shownPage(again, version.vision) }),
        )
      }
    }
    state.page = page
    return ok(shownPage(page, version.vision))
  }
  const text = (value: unknown) => (typeof value === "string" ? value : "")
  const count = (value: unknown) => (typeof value === "number" ? value : undefined)
  const isFolder = (at: string) =>
    fs.stat(at).then(
      (s) => s.isDirectory(),
      () => false,
    )

  // The commands of the model run in Git Bash where the harness says so, and in PowerShell otherwise. The tool
  // `powershell` is for what only Windows has: its script is read for the places it names, not for the commands of
  // the harness that do the same.
  const bash = version.meta.terminal === "bash"
  /** A command of the terminal, read before it runs: the folder it changes to, and the places it names. */
  const terminal = async (
    given: string,
    folder: string,
    tool: "terminal" | "powershell" = "terminal",
  ): Promise<Answer> => {
    const shell: Shell = tool === "terminal" && bash ? "bash" : "powershell"
    const reading = tool === "terminal"
    const moved = reading ? movedBy(given, shell) : undefined
    if (moved && "rest" in moved && has("cd-in-terminal"))
      return terminal(moved.rest, inFolder(folder, await local(moved.folder)))
    if (moved && "cd" in moved && has("cd-in-terminal"))
      return no(say("cd-in-terminal", { listing: await listing(project) }))
    const at = await located(project, folder)
    if (!at.inside && !reach(at.whole, "write")) return files.outside(folder)
    if (!(await isFolder(at.whole))) return no(`No folder ${at.shown}. The project holds:\n${await listing(project)}`)

    const outside = commands.commandPaths
      ? pathsIn(given, shell).find((named) => {
          const whole = path.resolve(at.whole, shell === "bash" ? fromBash(named) : named)
          return elsewhere(named) || (!place(project, whole).inside && !reach(whole, "write"))
        })
      : undefined
    return outside ? files.outside(outside) : execute(given, at.whole, shell)
  }
  const pageView = async (a: Args) => {
    const target = text(a.page)
    if (/^https?:\/\//i.test(target)) return view(target)
    const at = await located(project, target)
    if (!at.inside && !reach(at.whole, "read")) return files.outside(target)
    if (await isFolder(at.whole)) return no(`${at.shown} is a folder.`)
    if (!(await Bun.file(at.whole).exists())) return missing(project, at.whole)
    return view(at.whole)
  }
  const waiting = { seconds: DEFAULT_SECONDS }
  const execute = async (command: string, cwd: string, shell: Shell): Promise<Answer> => {
    const ran = await run({ command, cwd, seconds: waiting.seconds, env: options.env, shell }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw error
      return undefined
    })
    if (!ran)
      return no(
        `A command of ${command.length.toLocaleString("en-US")} characters is more than ${shell} takes. Split it into shorter commands.`,
      )
    const longer =
      waiting.seconds < MOST_SECONDS && schemas.get("terminal")?.parameters.properties.timeout
        ? ` To wait longer give \`timeout\`, up to ${MOST_SECONDS} seconds.`
        : ""
    const end = ran.stopped ? `Stopped after ${waiting.seconds} seconds.${longer}` : ran.code ? `exit ${ran.code}` : ""
    return {
      text: [ran.text || (ran.code ? "(the command failed and printed nothing)" : end ? "" : "(no output)"), end]
        .filter(Boolean)
        .join("\n\n"),
      failed: ran.stopped || ran.code !== 0,
    }
  }

  /** A call of `terminal` or `powershell`: refused when it fetches a page the browser opens, and undone when it
   *  would lose files the user gave. */
  const inTerminal = async (
    tool: "terminal" | "powershell",
    command: string,
    folder: string,
    a: Args,
  ): Promise<Answer & { again?: true }> => {
    waiting.seconds = Math.min(MOST_SECONDS, count(a.timeout) ?? DEFAULT_SECONDS)
    // A site of today is written by its scripts: what a program of the terminal gets is an empty page.
    const page = has("web-in-terminal") ? fetchedPage(command) : undefined
    if (page) return no(say("web-in-terminal", { url: page.replace(/[.,;:!?'")\]]+$/, "") }))
    const given = state.given
    if (!watching() || !given || !RISKY.test(command)) return terminal(command, folder, tool)
    const before = await keep(project)
    const done = await terminal(command, folder, tool)
    const after = await keep(project)
    const lost = lostBetween(given, before, after)
    if (!lost.some((one) => !state.warned.has(one.shown.toLowerCase()))) return done
    // Put back before the user is asked: they are asked about the project as it was.
    await restore(project, before, after)
    return (await held(lost)) ?? done
  }

  const COMMANDS = new Map<string, (a: Args) => Promise<Answer & { again?: true }>>(
    Object.entries({
      [version.command]: async (a: Args) => {
        const name = text(a.name)
          .replace(/^skill\s+/, "")
          .trim()
        if (!pages.has(name)) return no(`No skill named ${name}. The skills are: ${skills.join(", ")}.`)
        return ok(skill(name))
      },
      read: (a: Args) => read(files, { path: text(a.path), from: count(a.from), lines: count(a.lines) }),
      edit: (a: Args) =>
        edit(files, {
          path: text(a.path),
          old: typeof a.old === "string" ? a.old : undefined,
          new: text(a.new),
          all: a.all === true,
        }),
      search: (a: Args) =>
        search(files, {
          name: text(a.name) || undefined,
          text: text(a.text) || undefined,
          folder: text(a.folder) || undefined,
        }),
      write: async (a: Args) => {
        const target = path.resolve(project, text(a.path))
        const fresh = !(await fs.exists(target))
        const at = place(project, text(a.path))
        if (watching() && state.given && at.inside && !fresh && !(await isFolder(at.whole))) {
          const lost = lostIn(
            state.given,
            await fs.readFile(at.whole),
            at.shown.toLowerCase(),
            Buffer.from(text(a.content)),
          )
          const refused = lost && (await held([lost]))
          if (refused) return refused
        }
        const done = await write(files, { path: text(a.path), content: text(a.content) })
        // A file made under a name of its own while one of the same kind that the user named is still missing.
        const kin = [...state.named].filter(
          (name) => path.extname(name).toLowerCase() === path.extname(target).toLowerCase(),
        )
        const said = (part: string) => {
          const word = new RegExp(`(^|[^\\p{L}\\p{N}_.-])${escaped(part.toLowerCase())}(?=$|[^\\p{L}\\p{N}_-])`, "u")
          return state.said.some((text) => word.test(text))
        }
        // A file of the project is the one named: at that path, or, for a name without a folder, under a folder whose
        // every part the user named.
        const fulfils = (name: string, file: string) => {
          const [wanted, at] = [name, file].map((one) => one.replaceAll("\\", "/").toLowerCase())
          if (wanted === at) return true
          return (
            !wanted.includes("/") && path.posix.basename(at) === wanted && path.posix.dirname(at).split("/").every(said)
          )
        }
        const written = done.written
        const watched = written && fresh && kin.length > 0 && has("file-named-otherwise")
        const all = watched ? await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: project, dot: true })) : []
        const own = written && kin.some((name) => fulfils(name, path.relative(project, written.whole)))
        const missing = kin.filter((name) => !all.some((file) => fulfils(name, file))).map((name) => `\`${name}\``)
        const named =
          written && watched && !own && missing.length
            ? `\n\n${aside(say("file-named-otherwise", { path: written.shown, named: missing.join(" or ") }))}`
            : ""
        if (!done.written || !/\.html?$/i.test(done.written.whole))
          return { text: done.text + named, failed: done.failed }
        return ok(
          (has("after-page-written") ? `${done.text}\n\n${aside(say("after-page-written"))}` : done.text) + named,
        )
      },
      terminal: (a: Args) => inTerminal("terminal", text(a.command), text(a.folder) || ".", a),
      powershell: (a: Args) => inTerminal("powershell", text(a.script), ".", a),
      web_search: async (a: Args) => {
        if (has("web-before-own-tools") && tools.size && !state.toolsUsed) {
          state.toolsUsed = true
          const listed = [...tools.values()].map((tool) => `- \`${tool.name}\`: ${tool.description}`).join("\n")
          return { ...ok(say("web-before-own-tools", { tools: listed })), again: true as const }
        }
        const found = await options.web.search(text(a.query), count(a.days))
        if (found instanceof Error) return no("The web cannot be reached.")
        if (found.length === 0) return ok(`Nothing found for ${text(a.query)}.`)
        found.forEach((result) => state.known.add(address(result.url)))
        state.web.results = true
        const results = found
          .map((result, i) =>
            [`${i + 1}. ${result.title}`, result.url, result.date, result.text].filter(Boolean).join("\n   "),
          )
          .join("\n")
        return ok(results)
      },
      web_open: async (a: Args) => {
        const url = text(a.url)
        if (!/^https?:\/\//i.test(url)) return no("Give an address that starts with http:// or https://.")
        if (!state.known.has(address(url)))
          return no(
            `That address is in no result of a search and in no message. \`web_search\` first, then open a result.`,
          )
        const opened = await options.web.open(url)
        if (opened instanceof Error) return no(`The page could not be opened: ${opened.message}`)
        state.web.opened = true
        const lines = opened.text.split("\n")
        return ok(
          `${[opened.title, opened.date].filter(Boolean).join("\n")}\n\n${lines.slice(0, 300).join("\n")}${lines.length > 300 ? `\n(the first 300 lines of ${lines.length})` : ""}`,
        )
      },
      page_view: pageView,
      page_look: async (a: Args) => {
        if (text(a.page)) {
          const opened = await pageView(a)
          if (opened.failed) return opened
        }
        if (!state.page) return no("No page is open: give `page`, or `page_view` one first.")
        const picture = await options.browser.look?.()
        if (picture === undefined || picture instanceof Error)
          return no(`The page could not be photographed: ${picture?.message ?? "this browser takes no pictures"}.`)
        return { text: LOOK_ANSWER, failed: false, images: [picture] }
      },
      page_act: async (a: Args) => {
        if (!state.page) return no("No page is open: `page_view` one first.")
        const action = text(a.action)
        if (action !== "click" && action !== "type" && action !== "press")
          return no("`action` is `click`, `type` or `press`.")
        const on = count(a.on)
        const controls = state.page.items.filter((item) => "control" in item).length
        if (action !== "press" && on === undefined)
          return no(`\`${action}\` needs \`on\`: the number of the link, button or field.`)
        if (on !== undefined && on > controls)
          return no(
            controls
              ? `There is no ${on} on the page: the numbers go from 1 to ${controls}.`
              : "The page has nothing to click or fill.",
          )
        if (action !== "click" && !text(a.text))
          return no(
            action === "type" ? "`type` needs `text`: what to write." : "`press` needs `text`: the key, like `Enter`.",
          )
        const page = await options.browser.act(action, on, text(a.text) || undefined)
        if (page instanceof Error) return no(`The page did not take it: ${page.message}`)
        state.page = page
        return ok(shownPage(page, version.vision))
      },
      ask: async (a: Args) => {
        state.asked = true
        return ok(await options.user(text(a.question), Array.isArray(a.options) ? a.options.map(String) : []))
      },
      plan: async (a: Args) => {
        const given = text(a.text)
        const step = count(a.step)
        const done = count(a.done)
        if (given && step === undefined) {
          const plan = parsePlan(given)
          const form = schemas.get("plan")?.parameters.properties.text.description ?? ""
          if (!plan)
            return no(
              `A plan needs its steps, each under a \`## Step N: title\` line. The form:\n${form.slice(form.indexOf("\n") + 1)}`,
            )
          state.plan = plan
          return ok(`Plan kept, ${plan.steps.length} steps:\n${titles(plan)}\n\n${shownStep(plan, 1)}`)
        }
        const plan = state.plan
        if (!plan)
          return step === undefined && done === undefined ? ok("No plan yet") : no("No plan yet: write it with `text`.")
        if (step !== undefined) {
          if (!given) return no("`step` needs `text`: the step as it must be now.")
          if (step > plan.steps.length + 1)
            return no(
              `There is no step ${step}, and the next free one is ${plan.steps.length + 1}. The steps are:\n${titles(plan)}`,
            )
          const written = parseStep(given)
          const lines = written.text.split("\n")
          plan.steps[step - 1] = plan.steps[step - 1]
            ? { title: written.title ?? plan.steps[step - 1].title, text: written.text, done: false }
            : {
                title: written.title ?? lines[0],
                text: written.title ? written.text : lines.slice(1).join("\n").trim(),
                done: false,
              }
          return ok(`${titles(plan)}\n\n${shownStep(plan, step)}`)
        }
        if (done === undefined) return ok(whole(plan))
        if (!plan.steps[done - 1]) return no(`There is no step ${done}. The steps are:\n${titles(plan)}`)
        plan.steps[done - 1].done = true
        const next = plan.steps.findIndex((other) => !other.done)
        const aim = goal(plan)
        return ok(
          `${aim ? `Goal: ${aim}\n` : ""}${titles(plan)}\n\n${next < 0 ? "All steps done. Read the goal and Not doing once more, then answer the user" : shownStep(plan, next + 1)}`,
        )
      },
    }),
  )

  /** The arguments as the schema of the command wants them. What the schema does not name is left out, and so is
   *  an optional one given empty; a number or a yes/no written as text is taken. */
  function arranged(name: string, schema: Schema, given: Args): Args | string {
    const absent = schema.parameters.required.filter((key) => given[key] === undefined || given[key] === null)
    if (absent.length) return `\`${name}\` needs ${absent.map((key) => `\`${key}\``).join(" and ")}.`
    const entries = Object.entries(given)
      .filter(
        ([key, value]) =>
          Object.hasOwn(schema.parameters.properties, key) &&
          (schema.parameters.required.includes(key) || (value !== null && value !== undefined && value !== "")),
      )
      .map(([key, value]): [string, unknown] | string => {
        const type = schema.parameters.properties[key].type
        if (type === "integer")
          return Number.isInteger(Number(value)) && String(value).trim() !== "" && Number(value) >= 1
            ? [key, Number(value)]
            : `\`${key}\` must be a whole number, 1 or more.`
        if (type === "boolean") return [key, value === true || value === "true"]
        if (type === "string") return [key, typeof value === "string" ? value : JSON.stringify(value)]
        return [key, value]
      })
    return (
      entries.find((entry) => typeof entry === "string") ??
      Object.fromEntries(entries.filter((entry) => typeof entry !== "string"))
    )
  }

  return {
    system(): string[] {
      const prompt = version.system(project)
      if (!own.length) return [prompt]
      const lines = prompt.split("\n")
      const marker = `- \`${version.command} `
      const last = lines.findLastIndex((line) => line.startsWith(marker))
      if (last < 0) throw new Error(`the prompt of ${version.name} lists no skill: the user's own have nowhere to go`)
      // The descriptions of the user's skills start in the column of the harness's own.
      const column = lines[last].match(/^- `[^`]+`\s+/)?.[0].length ?? 0
      const added = own.map((one) => {
        const named = `- \`${version.command} ${one.name}\``
        return `${named.padEnd(Math.max(column, named.length + 1))}${one.description}`
      })
      // A skill of the user's named like one of the harness's takes its place in the list: it is the one that opens.
      const kept = lines.slice(0, last + 1).filter((line) => !own.some((one) => line.startsWith(`- \`${version.command} ${one.name}\``)))
      return [[...kept, ...added, ...lines.slice(last + 1)].join("\n")]
    },

    message(given: string) {
      state.messages++
      state.asked ||= state.messages > 1
      state.last = undefined
      state.said.push(given.toLowerCase().replaceAll("/", "\\"))
      for (const [, name] of [...given.matchAll(QUOTED), ...given.replace(QUOTED, " ").matchAll(BARE)])
        state.named.add(name)
      notice(given)
      return version.user(given)
    },

    async call(name: string, given: Args): Promise<Answer> {
      state.calls++
      state.taken = []
      // The project as the user gave it: nothing has changed it before the first call.
      if (watching() && !state.given) state.given = await keep(project)
      const mine = tools.get(name)
      if (mine) {
        state.toolsUsed = true
        state.last = undefined
        return ok(mine.answers)
      }
      const command = COMMANDS.get(name)
      const schema = schemas.get(name)
      if (!command || !schema)
        return no(`No command named ${name}. The commands are: ${[...schemas.keys()].join(", ")}.`)
      const a = arranged(name, schema, given)
      const ignored = Object.keys(given).filter((key) => !Object.hasOwn(schema.parameters.properties, key))
      const key = `${name} ${JSON.stringify(Object.entries(given).sort(([one], [other]) => one.localeCompare(other)))}`
      if (state.last?.key === key && state.last.failed && has("same-call-again")) {
        return no(say("same-call-again"))
      }
      // The arguments are the model's: whatever they are, the command answers and the conversation goes on.
      const done =
        typeof a === "string"
          ? no(a)
          : await Promise.all(
              Object.entries(a).map(
                async ([key, value]): Promise<[string, unknown]> => [
                  key,
                  typeof value === "string" && ["path", "folder", "page"].includes(key) ? await local(value) : value,
                ],
              ),
            )
              .then((entries) => command(Object.fromEntries(entries)))
              .catch((error: unknown) =>
                no(
                  `Error: ${(error instanceof Error ? error.message : String(error)).replaceAll(project + path.sep, "")}`,
                ),
              )
      // A refusal that asks for the same call again must not meet the refusal of a call that is repeated.
      state.last = "again" in done ? undefined : { key, failed: done.failed }
      const openNow =
        planEveryCalls && state.calls % planEveryCalls.every === 0 && state.plan ? openSteps(state.plan) : ""
      const unused = ignored.length
        ? `Ignored: ${ignored.map((key) => `\`${key}\``).join(", ")} ${ignored.length > 1 ? "are not arguments" : "is not an argument"} of \`${name}\`.`
        : ""
      const added = [
        done.failed && has("after-failed-call") ? aside(say("after-failed-call")) : "",
        // With a plan open, what to do next is its next step: the line that says to answer now would contradict it.
        everyCalls && !openNow && state.calls % everyCalls.every === 0
          ? aside(say(everyCalls.moment, { calls: String(state.calls) }))
          : "",
        planEveryCalls && openNow ? aside(say(planEveryCalls.moment, { open_steps: openNow })) : "",
      ]
      return {
        text: [[...new Set(state.taken), done.text].join("\n"), unused, ...added].filter(Boolean).join("\n\n"),
        failed: done.failed,
        ...(done.images ? { images: done.images } : {}),
      }
    },

    answer(): string | undefined {
      // The lines of the results are a few words of each page, often from sites that repeat an old fact.
      if (state.web.held || !has("answer-without-opening") || !state.web.results || state.web.opened) return undefined
      state.web.held = true
      return say("answer-without-opening")
    },

    async close() {
      await options.browser.close()
    },
  }
}
