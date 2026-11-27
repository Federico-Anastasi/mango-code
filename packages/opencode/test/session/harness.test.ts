import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Harness } from "@/session/harness"

const saved = { home: process.env.MANGO_HOME, settings: process.env.MANGO_SETTINGS }
let data: string

beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"))
  // the fixed harnesses are built in: they do not need the app's folder
  delete process.env.MANGO_HOME
  process.env.MANGO_SETTINGS = path.join(data, "settings.json")
  Harness.forget()
})

afterEach(() => {
  for (const [key, value] of [
    ["MANGO_HOME", saved.home],
    ["MANGO_SETTINGS", saved.settings],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Harness.unwatch()
  fs.rmSync(data, { recursive: true, force: true })
})

const choose = (models: Record<string, string>) =>
  fs.writeFileSync(
    path.join(data, "choices.json"),
    JSON.stringify({ models: Object.fromEntries(Object.entries(models).map(([key, harness]) => [key, { harness }])) }),
  )
const own = (id: string, json: unknown, files: Record<string, string> = {}) => {
  const dir = path.join(data, "harness", id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "harness.json"), JSON.stringify(json))
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text)
}

describe("harness definitions", () => {
  test("Mango Harness 1 is the default, with the numbers of its discipline reminders", () => {
    const h = Harness.forModel("qwen3.6-35b-a3b")
    expect(h.id).toBe(Harness.DEFAULT)
    expect(h.name).toBe("Mango Harness 1")
    expect(h.fixed).toBe(true)
    expect(h.hooks["discipline-messages"]).toEqual({ on: true, every: 3 })
    expect(h.hooks["discipline-calls"]).toEqual({ on: true, every: 12 })
  })

  test("a hook's text comes from hooks.md, by its heading", () => {
    const h = Harness.forModel("any")
    expect(h.texts["discipline-calls"]).toStartWith("<mango-discipline>\nDISCIPLINE - keep these rules active:\n1. Verify:")
    expect(h.texts["discipline-calls"]).toEndWith("</mango-discipline>")
  })

  test("the choices give a harness to a model", () => {
    own("mine", { name: "My harness", from: "mango-harness-1", hooks: { "discipline-messages": { on: true, every: 5 } } })
    choose({ "ling-tiny": "mine" })
    const h = Harness.forModel("ling-tiny")
    expect(h.id).toBe("mine")
    expect(h.fixed).toBe(false)
    expect(h.hooks["discipline-messages"]).toEqual({ on: true, every: 5 })
    expect(Harness.forModel("other").id).toBe(Harness.DEFAULT)
    // a server's model with a catalog key's name is not that model
    expect(Harness.forModel("ling-tiny", "server-1").id).toBe(Harness.DEFAULT)
  })

  test("what a user harness does not say comes from the harness it was made from", () => {
    own("mine", { name: "Mine", from: "mango-harness-1", hooks: { "discipline-calls": { on: false } } })
    choose({ m: "mine" })
    const h = Harness.forModel("m")
    expect(h.hooks["discipline-calls"]).toEqual({ on: false, every: 12 })
    expect(h.hooks["discipline-messages"]).toEqual({ on: true, every: 3 })
    expect(h.texts["discipline-messages"]).toBe(Harness.forModel("x").texts["discipline-messages"])
  })

  test("a user harness's hooks.md replaces only the texts it has", () => {
    own("mine", { name: "Mine", from: "mango-harness-1" }, { "hooks.md": "## discipline-calls\nOnly this.\n" })
    choose({ m: "mine" })
    expect(Harness.forModel("m").texts["discipline-calls"]).toBe("Only this.")
  })

  test("a model given a harness that is not there stops with its name", () => {
    choose({ m: "gone" })
    expect(() => Harness.forModel("m")).toThrow(/gone/)
  })

  test("a harness.json that is not valid stops with the file", () => {
    own("bad", { name: "Bad", from: "mango-harness-1", hooks: { "discipline-messages": { on: "yes" } } })
    choose({ m: "bad" })
    expect(() => Harness.forModel("m")).toThrow(/harness\.json/)
  })

  test("a hook the code does not know stops with its name", () => {
    own("bad", { name: "Bad", from: "mango-harness-1", hooks: { "made-up": { on: true } } })
    choose({ m: "bad" })
    expect(() => Harness.forModel("m")).toThrow(/made-up/)
  })

  test("a conversation keeps the harness of the model of its last request", () => {
    own("mine", { name: "Mine", from: "mango-harness-1" })
    choose({ m: "mine" })
    expect(Harness.ofSession("s1").id).toBe(Harness.DEFAULT)
    Harness.bind("s1", "m", "mango")
    expect(Harness.ofSession("s1").id).toBe("mine")
    Harness.bind("s1", "other", "mango")
    expect(Harness.ofSession("s1").id).toBe(Harness.DEFAULT)
  })
})

describe("Mango Harness 1", () => {
  const saved = { programs: process.env.MANGO_PC_PROGRAMS, role: process.env.MANGO_TEAM_ROLE }
  afterEach(() => {
    for (const [key, value] of [
      ["MANGO_PC_PROGRAMS", saved.programs],
      ["MANGO_TEAM_ROLE", saved.role],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("its prompt holds the whole text the model reads before the project's: the base and what Mango Code is", () => {
    const h = Harness.definition("mango-harness-1")
    expect(h.prompt).toStartWith("You are Mango Code, an AI agent that runs on the user's own computer")
    expect(h.prompt).toContain("\n\n# mango-code\n\nYou are Mango Code: an AI agent that works on this computer")
    expect(h.prompt).toEndWith("\n\n{{role}}\n{{programs}}\n")
  })

  test("the programs of the PC come from the app's environment, in the line that asks for them", () => {
    const h = Harness.definition("mango-harness-1")
    process.env.MANGO_PC_PROGRAMS = "## Tools on this PC\n\nPython 3.12.\n"
    const filled = Harness.basePrompt(h)
    expect(filled).toEndWith("`Attachments` folder.\n\n## Tools on this PC\n\nPython 3.12.\n")
    expect(filled).not.toContain("{{")
  })

  test("a hidden process of the Team reads its role before the programs; the app's own process, the manager and a PC without data have none", () => {
    const h = Harness.definition("mango-harness-1")
    process.env.MANGO_PC_PROGRAMS = "## Tools on this PC\n"
    process.env.MANGO_TEAM_ROLE = "dev"
    const dev = Harness.basePrompt(h)
    expect(dev).toContain("`Attachments` folder.\n\n# Role: DEV (in a team)\n")
    expect(dev).toEndWith("without you having to stop and write to him.\n\n## Tools on this PC\n")
    process.env.MANGO_TEAM_ROLE = "agent"
    expect(Harness.basePrompt(h)).toContain("\n\n# Role: AGENT (in a team, under a manager)\n")
    process.env.MANGO_TEAM_ROLE = "manager"
    expect(Harness.basePrompt(h)).toEndWith("`Attachments` folder.\n\n## Tools on this PC\n")
    delete process.env.MANGO_PC_PROGRAMS
    expect(Harness.basePrompt(h)).not.toContain("{{")
  })

  test("a harness made from it has its whole prompt, which it can change", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    expect(Harness.definition(id).prompt).toBe(Harness.definition("mango-harness-1").prompt)
    await Harness.update(id, { prompt: "My prompt.\n{{programs}}\n" })
    process.env.MANGO_PC_PROGRAMS = "Programs.\n"
    expect(Harness.basePrompt(Harness.definition(id))).toBe("My prompt.\nPrograms.\n")
  })
})

describe("Mango Harness 2", () => {
  test("brings its prompt, its tools, its skills and its hooks with their numbers", () => {
    choose({ fusion: "mango-harness-2" })
    const h = Harness.forModel("fusion")
    expect([h.name, h.kind, h.fixed, h.command]).toEqual(["Mango Harness 2", "commands", true, "skill"])
    expect(h.prompt).toStartWith("You are Mango Code, an AI agent that runs on the user's own computer")
    expect(h.prompt).toContain("- Project: {{project}}.")
    expect(h.core).toHaveLength(13)
    expect(h.terminal).toBe("bash")
    expect(Object.keys(h.tools ?? {})).toContain("terminal")
    expect(Object.keys(h.skills ?? {}).sort()).toEqual(["debugging", "done", "page-check", "planning", "test-first", "web-research"])
    expect(h.hooks["every-calls"]).toEqual({ on: true, every: 8 })
    expect(h.hooks["unreadable-call"]).toEqual({ on: true, times: 2 })
    expect(h.texts["rules-in-messages"]).toStartWith("<mango-rules>\n")
    expect(h.texts["would-lose"]).toContain("{{what}}")
    expect(h.commands?.told).toBe(true)
  })

  test("a harness made from it changes a tool's description, not its parameters", () => {
    own("mine", { name: "Mine", from: "mango-harness-2" }, {
      "tools.json": JSON.stringify({ terminal: { description: "Runs it.", parameters: { type: "object" } } }),
    })
    choose({ m: "mine" })
    const h = Harness.forModel("m")
    const base = Harness.definition("mango-harness-2")
    expect(h.kind).toBe("commands")
    expect(h.tools?.terminal.description).toBe("Runs it.")
    expect(h.tools?.terminal.parameters).toEqual(base.tools?.terminal.parameters)
    expect(h.prompt).toBe(base.prompt)
  })
})

test("the switches of the settings page turn a hook on or off over what its harness says; the numbers stay", () => {
  const base = Harness.definition("mango-harness-2")
  const switched = Harness.withSwitches(base, (hook) => (hook === "would-lose" ? false : hook === "every-calls" ? true : undefined))
  expect(switched.hooks["would-lose"]).toEqual({ on: false })
  expect(switched.hooks["every-calls"]).toEqual({ on: true, every: 8 })
  expect(switched.hooks["outside-project"]).toEqual(base.hooks["outside-project"])
  expect(base.hooks["would-lose"].on).toBe(true)
})

test("a harness made from Mango Harness 2 can turn on Mango Harness 1's discipline, with its numbers and its texts", () => {
  own("mine", { name: "Mine", from: "mango-harness-2", hooks: { "discipline-messages": { on: true } } })
  choose({ m: "mine" })
  const h = Harness.forModel("m")
  expect(h.hooks["discipline-messages"]).toEqual({ on: true, every: 3 })
  expect(Harness.withSwitches(h, () => undefined).hooks["discipline-messages"]).toEqual({ on: true, every: 3 })
  expect(h.texts["discipline-messages"]).toStartWith("<mango-discipline>\nStanding rules")
})

test("a hook of the commands does not run in a harness made from Mango Harness 1, which says so", () => {
  own("mine", { name: "Mine", from: "mango-harness-1", hooks: { "would-lose": { on: true } } })
  choose({ m: "mine" })
  expect(() => Harness.forModel("m")).toThrow(/would-lose/)
})

describe("the user's harnesses", () => {
  test("the list has the harnesses of Mango Code first, then the user's", async () => {
    own("mine", { name: "Mine", from: "mango-harness-2" })
    expect(Harness.list().map((h) => [h.id, h.name, h.fixed])).toEqual([
      ["mango-harness-1", "Mango Harness 1", true],
      ["mango-harness-2", "Mango Harness 2", true],
      ["mine", "Mine", false],
    ])
  })

  test("duplicating makes a folder named after the name, made from the harness of Mango Code behind it", async () => {
    const first = await Harness.duplicate("mango-harness-2", "My harness")
    expect(first).toBe("my-harness")
    const again = await Harness.duplicate(first, "My harness")
    expect(again).toBe("my-harness-2")
    const made = Harness.definition(again)
    expect([made.name, made.kind, made.fixed]).toEqual(["My harness", "commands", false])
    expect(JSON.parse(fs.readFileSync(path.join(data, "harness", again, "harness.json"), "utf8"))).toEqual({
      name: "My harness",
      from: "mango-harness-2",
    })
  })

  test("a duplicate of the user's own harness takes its texts and numbers too", async () => {
    const first = await Harness.duplicate("mango-harness-2", "One")
    await Harness.update(first, { hooks: { "every-calls": { every: 5 } }, texts: { "every-calls": "Now {{calls}}." } })
    const second = await Harness.duplicate(first, "Two")
    const made = Harness.definition(second)
    expect(made.hooks["every-calls"].every).toBe(5)
    expect(made.texts["every-calls"]).toBe("Now {{calls}}.")
  })

  test("a change writes only what it says, and the harness is read again", async () => {
    const id = await Harness.duplicate("mango-harness-2", "Mine")
    await Harness.update(id, {
      name: "Renamed",
      prompt: "You are a test.\n- Project: {{project}}.",
      tools: { terminal: "Runs it." },
      hooks: { "every-calls": { every: 4 } },
      texts: { "every-calls": "Done {{calls}}?" },
    })
    const h = Harness.definition(id)
    expect([h.name, h.prompt, h.tools?.terminal.description, h.hooks["every-calls"], h.texts["every-calls"]]).toEqual([
      "Renamed",
      "You are a test.\n- Project: {{project}}.",
      "Runs it.",
      { on: true, every: 4 },
      "Done {{calls}}?",
    ])
    expect(h.texts["would-lose"]).toBe(Harness.definition("mango-harness-2").texts["would-lose"])
  })

  test("the harnesses of Mango Code are not changed nor removed", async () => {
    await expect(Harness.update("mango-harness-2", { name: "Other" })).rejects.toThrow(/Mango Code/)
    await expect(Harness.remove("mango-harness-1")).rejects.toThrow(/Mango Code/)
  })

  test("a harness a model uses is not removed: the error names the model", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Used")
    choose({ "qwen-4b": id })
    await expect(Harness.remove(id)).rejects.toThrow(/qwen-4b/)
    choose({})
    await Harness.remove(id)
    expect(fs.existsSync(path.join(data, "harness", id))).toBe(false)
    expect(() => Harness.definition(id)).toThrow(/Used|used/)
  })

  test("a name that is not a harness of the list touches nothing outside its folder", async () => {
    fs.writeFileSync(path.join(data, "settings.json"), "{}")
    for (const id of ["..", "../harness", "a/..", "..\\..", "constructor", "toString"]) {
      await expect(Harness.remove(id)).rejects.toThrow(/not there|non c'è/)
      await expect(Harness.update(id, { name: "X" })).rejects.toThrow(/not there|non c'è/)
      await expect(Harness.duplicate(id, "X")).rejects.toThrow(/not there|non c'è/)
      expect(() => Harness.definition(id)).toThrow(/not there|non c'è/)
    }
    expect(fs.existsSync(path.join(data, "settings.json"))).toBe(true)
  })

  test("changing the text or the number of a hook that is off leaves it off", async () => {
    const id = await Harness.duplicate("mango-harness-2", "Mine")
    expect(Harness.definition(id).hooks["discipline-calls"]?.on ?? false).toBe(false)
    await Harness.update(id, { hooks: { "discipline-calls": {} }, texts: { "discipline-calls": "Mind the rules." } })
    expect(Harness.definition(id).hooks["discipline-calls"]?.on ?? false).toBe(false)
    await Harness.update(id, { hooks: { "discipline-calls": { every: 4 } } })
    expect(Harness.definition(id).hooks["discipline-calls"]).toEqual({ on: false, every: 4 })
    await Harness.update(id, { hooks: { "discipline-calls": { on: true } } })
    expect(Harness.definition(id).hooks["discipline-calls"]).toEqual({ on: true, every: 4 })
  })

  test("a hook's text with a heading of its own is read back whole", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    const text = "Before you go on:\n\n## Rules\n- read the file first"
    await Harness.update(id, { texts: { "discipline-calls": text } })
    expect(Harness.definition(id).texts["discipline-calls"]).toBe(text)
    expect(Harness.definition(id).texts["discipline-messages"]).toBe(Harness.definition("mango-harness-1").texts["discipline-messages"])
  })

  test("a harness changed on the disk is read again, also when its folder was made after the agent started", async () => {
    Harness.forModel("qwen-4b")
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    expect(Harness.definition(id).texts["discipline-calls"]).not.toBe("By hand.")
    fs.writeFileSync(path.join(data, "harness", id, "hooks.md"), "## discipline-calls\nBy hand.\n")
    for (let i = 0; i < 40 && Harness.definition(id).texts["discipline-calls"] !== "By hand."; i++) await Bun.sleep(50)
    expect(Harness.definition(id).texts["discipline-calls"]).toBe("By hand.")
  })

  test("the choices of the app are read when its folder was made after the agent started", () => {
    const later = path.join(data, "later")
    process.env.MANGO_SETTINGS = path.join(later, "settings.json")
    Harness.forget()
    expect(Harness.forModel("qwen-4b").id).toBe(Harness.DEFAULT)
    fs.mkdirSync(later)
    fs.writeFileSync(path.join(later, "choices.json"), JSON.stringify({ models: { "qwen-4b": { harness: "mango-harness-2" } } }))
    expect(Harness.forModel("qwen-4b").id).toBe("mango-harness-2")
  })

  test("removing a harness that is not there says so", async () => {
    await expect(Harness.remove("never-made")).rejects.toThrow(/never-made/)
  })

  test("a number below 1 or a hook the kind cannot run is refused before anything is written", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    await expect(Harness.update(id, { hooks: { "discipline-calls": { every: 0 } } })).rejects.toThrow(/every/)
    await expect(Harness.update(id, { hooks: { "would-lose": {} } })).rejects.toThrow(/would-lose/)
    expect(Harness.definition(id).hooks["discipline-calls"].every).toBe(12)
  })
})

describe("the texts of the summary", () => {
  test("both harnesses of Mango Code have every text, and the second says plan where the first says task list", () => {
    const one = Harness.definition("mango-harness-1").compaction
    const two = Harness.definition("mango-harness-2").compaction
    for (const name of Harness.COMPACTION_TEXTS) {
      expect(one[name]?.trim()).toBeTruthy()
      expect(two[name]?.trim()).toBeTruthy()
    }
    const different = Harness.COMPACTION_TEXTS.filter((name) => one[name] !== two[name])
    expect(different).toEqual(["rule", "continued"])
    expect(two.rule).toContain("your plan")
    expect(one.rule).toContain("your task list")
    expect(one.template).toStartWith("Output exactly the Markdown structure shown inside <template>")
    expect(one.template).toContain("## Next Move\n1. [immediate concrete action")
    expect(one.template).toEndWith("- Do not mention the summary process or that context was compacted.")
    expect(one.missing).toContain("{{missing}}")
  })

  test("a user's harness changes one text and keeps the others of the harness it was made from", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    await Harness.update(id, { compaction: { first: "Write the summary of the work so far." } })
    const made = Harness.definition(id).compaction
    expect(made.first).toBe("Write the summary of the work so far.")
    expect(made.template).toBe(Harness.definition("mango-harness-1").compaction.template)
    expect(fs.readFileSync(path.join(data, "harness", id, "compaction.md"), "utf8")).toStartWith("## first\nWrite the summary")
    // a copy of it keeps the change
    const copy = await Harness.duplicate(id, "Copy")
    expect(Harness.definition(copy).compaction.first).toBe("Write the summary of the work so far.")
  })

  test("a text with headings of its own is read back whole", async () => {
    const id = await Harness.duplicate("mango-harness-2", "Mine")
    const template = "Use this:\n\n## Objective\n- the aim\n\n## Next Move\n1. the step"
    await Harness.update(id, { compaction: { template } })
    expect(Harness.definition(id).compaction.template).toBe(template)
    expect(Harness.definition(id).compaction.rule).toBe(Harness.definition("mango-harness-2").compaction.rule)
  })

  test("an empty text, an unknown one, or a line about the messages left out without its number is refused", async () => {
    const id = await Harness.duplicate("mango-harness-1", "Mine")
    await expect(Harness.update(id, { compaction: { first: "  " } })).rejects.toThrow(/first/)
    await expect(Harness.update(id, { compaction: { tail: "x" } })).rejects.toThrow(/tail/)
    await expect(Harness.update(id, { compaction: { missing: "Some are left out." } })).rejects.toThrow(/\{\{missing\}\}/)
    expect(Harness.definition(id).compaction.first).toBe(Harness.definition("mango-harness-1").compaction.first)
  })

  test("a user's compaction.md may hold only some of the texts: the others come from the harness it was made from", () => {
    own("mine", { name: "Mine", from: "mango-harness-1" }, { "compaction.md": "## first\nOnly this.\n" })
    choose({ m: "mine" })
    expect(Harness.forModel("m").compaction.first).toBe("Only this.")
    expect(Harness.forModel("m").compaction.update).toBe(Harness.definition("mango-harness-1").compaction.update)
  })
})
