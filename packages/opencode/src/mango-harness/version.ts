// What `openHarness` takes from a harness definition (session/harness.ts): the system prompt for a project, the user's
// message, the hooks as moments with their texts, the tools the model sees.
import fs from "node:fs"
import path from "node:path"
import type { Definition } from "@/session/harness"

/** How the commands of a harness behave where they could differ:
 *  - `spaces`: `edit` finds the old text also when spaces at the ends of its lines differ;
 *  - `commandPaths`: a command of the terminal that names a place outside the project is not run;
 *  - `told`: a loss the user's request orders is not asked about by the hook `would-lose`: a file deleted that the
 *    request names (with or without its extension, or by its extension alone) beside a word for deleting, a file
 *    written over that it names beside a word for rewriting. */
export type Commands = {
  spaces: boolean
  commandPaths: boolean
  told?: boolean
}

type Schema = { description: string; parameters: unknown }

/** The tools of the sight: declared like every other, offered only when the model sees. */
const SIGHT = ["page_look"]

/** The hooks that are not moments of the harness: the agent runs them around it (session/commands-harness.ts). */
const NOT_MOMENTS = new Set(["rules-in-messages", "unreadable-call", "discipline-messages", "discipline-calls"])

/** The moment a hook of the definition is for in the harness: the ones with a number carry it in their name. */
const moment = (name: string, every?: number) =>
  name === "every-calls"
    ? `every-${every}-calls`
    : name === "plan-open-every-calls"
      ? `plan-open-every-${every}-calls`
      : name

/** `date`: the day shown in the prompt, as `Date.toDateString()` writes it; today's when it is not given. `off`: what
 *  the settings page switched off, the skills (out of the list and of the pages) and the project's instructions.
 *  `vision`: the model sees pictures, so the tools of the sight are offered and `read` gives pictures. */
export function versionOf(
  definition: Definition,
  options: { date?: string; off?: { skills?: string[]; instructions?: boolean }; vision?: boolean } = {},
) {
  const { prompt, tools, command } = definition
  if (prompt === undefined) throw new Error(`the harness ${definition.id} has no prompt.md`)
  if (!tools) throw new Error(`the harness ${definition.id} has no tools.json`)
  if (!command || !tools[command]) throw new Error(`the harness ${definition.id} has no tool that opens a skill`)
  const commands = definition.commands as Commands | undefined
  const rules = definition.hooks["rules-in-messages"]?.on
    ? (definition.texts["rules-in-messages"] ?? "").trim()
    : undefined
  const retries = definition.hooks["unreadable-call"]
  const hooks = new Map(
    Object.entries(definition.hooks)
      .filter(([name, hook]) => hook.on && !NOT_MOMENTS.has(name))
      .map(([name, hook]): [string, string] => [moment(name, hook.every), (definition.texts[name] ?? "").trim()]),
  )
  const off = new Set(options.off?.skills ?? [])
  const pages = new Map(
    Object.entries(definition.skills ?? {})
      .filter(([name]) => !off.has(name))
      .map(([name, text]) => [name, { body: text.replace(/\r\n/g, "\n").split("\n\n").slice(1).join("\n\n").trim() }]),
  )
  // A skill switched off leaves the list of the prompt: its line begins with the command and its name.
  const listed = (line: string) => ![...off].some((name) => line.startsWith(`- \`${command} ${name}\``))
  const vision = Boolean(options.vision) && SIGHT.some((name) => name in tools)
  const offered = (key: string) => vision || !SIGHT.includes(key)
  // The tool that opens a skill is declared first; the others follow in the order of the file.
  const real = Object.keys(tools).filter((key) => key !== command && offered(key))
  const declared = (key: string) => ({
    type: "function",
    function: { name: key, description: tools[key].description, parameters: tools[key].parameters },
  })
  const fill = (text: string, project: string) =>
    text
      .replaceAll("{{project}}", path.basename(project))
      .replaceAll("{{date}}", options.date ?? new Date().toDateString())

  return {
    name: definition.id,
    meta: { commands, terminal: definition.terminal, retries: retries?.on ? retries.times : undefined },
    vision,
    command,
    hooks,
    pages,
    fill,
    /** The system message for a conversation in this project folder: the prompt and the project's own instructions,
     *  which are named by their file alone, because a place on the disk shown here is a path the model copies. */
    system(project: string) {
      const own = path.join(project, "CLAUDE.md")
      const instructions =
        !options.off?.instructions && fs.existsSync(own)
          ? `\n\nInstructions from: CLAUDE.md\n${fs.readFileSync(own, "utf8").trim()}`
          : ""
      return fill(prompt.trim().split("\n").filter(listed).join("\n"), project) + instructions
    },
    /** The user's message as the model receives it. */
    user: (given: string) => (rules === undefined ? given : `${given}\n\n${rules}`),
    /** The tools usable before the model has opened any skill. */
    startingTools: () => (definition.core ?? []).filter(offered),
    /** The tool definitions sent with a request, for the tools usable at that moment. */
    declarations: (usable: Iterable<string>) => [declared(command), ...[...usable].map(declared)],
    /** The tools as the model sees them, by name: the tool that opens a skill first. */
    toolsFile: (): Record<string, Schema> =>
      Object.fromEntries(
        [command, ...real].map((key) => [
          key,
          { description: tools[key].description, parameters: tools[key].parameters },
        ]),
      ),
  }
}
