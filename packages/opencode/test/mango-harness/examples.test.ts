// Each file of examples/ is the first request of a conversation of Mango Harness 2: the system message, the user's
// first message and the tools. The harness must give exactly those from the definition: a change to its prompt, its
// tools or its rules shows here, and the files are written again on purpose.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Harness } from "@/session/harness"
import { openHarness } from "@/mango-harness/harness"
import { versionOf } from "@/mango-harness/version"

process.env.MANGO_HOME = path.resolve(import.meta.dir, "..", "..", "..", "..", "launcher")
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-examples-"))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

type Declared = { type: string; function: { name: string; description: string; parameters: unknown } }
type Example = { messages: { role: string; content: string }[]; tools: Declared[] }

const FOLDER = path.join(import.meta.dir, "examples")
const INSTRUCTIONS = "\n\nInstructions from: CLAUDE.md\n"
const RULES = "\n\n<mango-rules>"

for (const file of fs.readdirSync(FOLDER).filter((name) => name.endsWith(".json"))) {
  test(`the request of ${file} is what the harness gives`, async () => {
    const example: Example = JSON.parse(fs.readFileSync(path.join(FOLDER, file), "utf8"))
    const [system, first] = example.messages
    const name = system.content.match(/- Project: (.*)\. You are inside its folder/)?.[1]
    const date = system.content.match(/- Date: (.*)\.\n/)?.[1]
    expect([name, date].every(Boolean)).toBe(true)

    const project = path.join(fs.mkdtempSync(path.join(ROOT, "p-")), name!)
    fs.mkdirSync(project)
    const own = system.content.indexOf(INSTRUCTIONS)
    if (own >= 0) fs.writeFileSync(path.join(project, "CLAUDE.md"), system.content.slice(own + INSTRUCTIONS.length))

    const definition = Harness.definition("mango-harness-2")
    const version = versionOf(definition, { date })
    const declared = version.declarations(version.startingTools())
    expect(declared).toHaveLength(13)
    const given = example.tools.slice(declared.length)
    expect(given.every((tool) => !(tool.function.name in definition.tools!))).toBe(true)

    const harness = openHarness({
      project,
      version,
      web: { search: async () => new Error("offline"), open: async () => new Error("offline") },
      browser: {
        view: async () => new Error("none"),
        act: async () => new Error("none"),
        back: async () => new Error("none"),
        close: async () => {},
      },
      user: async () => "",
      tools: given.map((tool) => ({ name: tool.function.name, description: tool.function.description, answers: "" })),
    })

    expect(harness.system()).toEqual([system.content])
    expect(first.content.includes(RULES)).toBe(true)
    expect(harness.message(first.content.slice(0, first.content.indexOf(RULES)))).toBe(first.content)
    expect(JSON.stringify(declared)).toBe(JSON.stringify(example.tools.slice(0, declared.length)))
    expect(declared.map((tool) => tool.function.name)).toEqual(
      example.tools.slice(0, declared.length).map((tool) => tool.function.name),
    )
    await harness.close()
  })
}

test("the instructions of the project go at the end of the prompt, named by their file alone", () => {
  const project = path.join(fs.mkdtempSync(path.join(ROOT, "p-")), "tienda")
  fs.mkdirSync(project)
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "Answer in Spanish.\n\n")
  const prompt = versionOf(Harness.definition("mango-harness-2"), { date: "Sun Nov 22 2026" }).system(project)
  expect(prompt).toEndWith("\n\nInstructions from: CLAUDE.md\nAnswer in Spanish.")
  expect(prompt).toContain("- Project: tienda. You are inside its folder")
  expect(prompt).not.toContain(ROOT)
})
