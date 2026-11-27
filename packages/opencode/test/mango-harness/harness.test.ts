// The commands and the hooks of the harness, tried without a model: each test opens a harness on a throwaway
// project, with a definition made for it from Mango Harness 2, and calls the commands as a model would.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Harness, type Definition } from "@/session/harness"
import { openHarness } from "@/mango-harness/harness"
import { LOOK_HINT } from "@/mango-harness/look"
import type { Browser, Page, Skill, Web } from "@/mango-harness/contracts"
import { versionOf, type Commands } from "@/mango-harness/version"

// Windows PowerShell 5.1 takes seconds to start when the machine is busy: the default of 5 s is not a verdict.
setDefaultTimeout(60_000)

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"))
process.env.MANGO_HOME = path.resolve(import.meta.dir, "..", "..", "..", "..", "launcher")
const BASE = Harness.definition("mango-harness-2")
const SCHEMAS: NonNullable<Definition["tools"]> = {
  ...JSON.parse(fs.readFileSync(path.join(import.meta.dir, "tools.json"), "utf8")),
  terminal: BASE.tools!.terminal,
  powershell: BASE.tools!.powershell,
  page_look: BASE.tools!.page_look,
}

/** The hooks of a definition for the moments a test names; a reminder on every message is the hook `rules-in-messages`. */
function hooksOf(moments: Record<string, string>, reminder?: string) {
  const entries = Object.entries(moments).map(([moment, text]) => {
    const counted = moment.match(/^(plan-open-)?every-(\d+)-calls$/)
    const name = counted ? `${counted[1] ?? ""}every-calls` : moment
    return [name, counted ? { on: true, every: Number(counted[2]) } : { on: true }, text] as const
  })
  if (reminder) entries.push(["rules-in-messages", { on: true }, reminder])
  return {
    hooks: Object.fromEntries(entries.map(([name, hook]) => [name, hook])),
    texts: Object.fromEntries(entries.map(([name, , text]) => [name, text])),
  }
}
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const STRICT: Commands = { spaces: false, commandPaths: true }
const SHIPPED: Commands = { spaces: true, commandPaths: true }
const HOOKS = {
  "outside-project": "`{{path}}` is outside the project. It holds:\n{{listing}}",
  "same-call-again": "Same call as before: not run.",
}

const page = (html: string): Page => ({
  title: html.match(/<title>(.*?)<\/title>/)?.[1] ?? "",
  items: [{ text: "Hello" }, { control: "button", label: "Colour" }, { control: "field", label: "Name" }],
  errors: html.includes("boom") ? ["Uncaught ReferenceError: boom is not defined (page.html:3)"] : [],
})
const web: Web = {
  search: async (query) =>
    query === "offline"
      ? new Error("no network")
      : [
          {
            title: "Lanterna 2.0 is out",
            url: "https://lanterna.example/blog/2-0",
            date: "2026-10-01",
            text: "The new release of Lanterna.",
          },
        ],
  open: async (url) =>
    url.includes("lanterna.example")
      ? {
          title: "Lanterna 2.0 is out",
          date: "2026-10-01",
          text: "Lanterna 2.0 adds a dark theme.\nIt was released on 1 October.",
        }
      : new Error("this page cannot be reached"),
}

let made = 0
function start(
  options: {
    commands?: Commands
    terminal?: "bash"
    hooks?: Record<string, string>
    reminder?: string
    files?: Record<string, string>
    base?: string
    skills?: Skill[]
    tools?: { name: string; description: string; answers: string }[]
    browser?: Browser
    vision?: boolean
  } = {},
) {
  const name = `v${++made}`
  const definition: Definition = {
    ...BASE,
    id: name,
    prompt: options.base ?? "You are in {{project}}.",
    tools: SCHEMAS,
    skills: Object.fromEntries(
      ["planning", "debugging", "web-research"].map((skill) => [
        skill,
        `desc: the method of ${skill}

THE METHOD OF ${skill.toUpperCase()}`,
      ]),
    ),
    core: [],
    commands: options.commands ?? SHIPPED,
    terminal: options.terminal,
    ...hooksOf({ ...HOOKS, ...options.hooks }, options.reminder),
  }
  const project = fs.mkdtempSync(path.join(ROOT, "project-"))
  for (const [file, text] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true })
    fs.writeFileSync(path.join(project, file), text)
  }
  const acted: string[] = []
  const browser: Browser = {
    view: async (target) => (fs.existsSync(target) ? page(fs.readFileSync(target, "utf8")) : new Error("not found")),
    act: async (action, on, text) => {
      acted.push(`${action} ${on ?? ""} ${text ?? ""}`.trim())
      return { title: "After", items: [{ text: `done ${action}` }], errors: [] }
    },
    back: async () => new Error("no page before"),
    close: async () => {},
  }
  const asked: string[] = []
  const harness = openHarness({
    project,
    version: versionOf(definition, { vision: options.vision }),
    web,
    browser: options.browser ?? browser,
    user: async (question, choices) => (asked.push(`${question} [${choices.join("|")}]`), "the second"),
    skills: options.skills,
    tools: options.tools,
  })
  const call = async (command: string, args: Record<string, unknown> = {}) => (await harness.call(command, args)).text
  const file = (name: string) => fs.readFileSync(path.join(project, name), "utf8")
  return { harness, project, call, file, acted, asked }
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"

// ---------------------------------------------------------------- files

test("read gives the count in a first line and the lines as they are", async () => {
  const { call } = start({ files: { "notes.txt": TEN } })
  expect(await call("read", { path: "notes.txt", lines: 3 })).toBe("notes.txt, lines 1-3 of 10\nline 1\nline 2\nline 3")
  expect(await call("read", { path: "notes.txt", from: 9 })).toBe("notes.txt, lines 9-10 of 10\nline 9\nline 10")
})

test("read lists a folder, and a file that is not there comes with what its folder holds", async () => {
  const { call } = start({ files: { "src/app.js": "x", "notes.txt": "y" } })
  expect(await call("read", { path: "." })).toBe("notes.txt\nsrc/")
  expect(await call("read", { path: "src/main.js" })).toBe("No file src/main.js. The folder src holds:\napp.js")
})

test("a whole path inside the project is taken, and shown from the project folder", async () => {
  const { call, project } = start({ files: { "notes.txt": "one\n" } })
  expect(await call("read", { path: path.join(project, "notes.txt") })).toBe("notes.txt, lines 1-1 of 1\none")
  expect(await call("write", { path: path.join(project, "data", "new.txt"), content: "a\nb\n" })).toBe(
    "Written data/new.txt (2 lines)",
  )
})

test("a path outside the project is refused with what the project holds, and nothing is written", async () => {
  const { harness, project } = start({ files: { "notes.txt": "one\n" } })
  const outside = path.join(path.dirname(project), "fuori.txt")
  const answer = await harness.call("write", { path: outside, content: "x" })
  expect(answer).toEqual({ text: `\`${outside}\` is outside the project. It holds:\nnotes.txt`, failed: true })
  expect(fs.existsSync(outside)).toBe(false)
  expect((await harness.call("read", { path: "/workspace/notes.txt" })).failed).toBe(true)
})

test("the root of the drive is outside the project for every command that takes a path, even to read", async () => {
  const { harness, project } = start({ files: { "notes.txt": "one\n" } })
  const drive = path.parse(project).root
  const refused = (given: string) => ({
    text: `\`${given}\` is outside the project. It holds:\nnotes.txt`,
    failed: true,
  })
  for (const given of ["/", "\\", drive, drive.replaceAll("\\", "/"), "/*", "\\*", `${drive}*`]) {
    expect(await harness.call("read", { path: given })).toEqual(refused(given))
    expect(await harness.call("search", { folder: given, name: "*.txt" })).toEqual(refused(given))
    expect(await harness.call("write", { path: given, content: "x" })).toEqual(refused(given))
    expect(await harness.call("edit", { path: given, old: "a", new: "b" })).toEqual(refused(given))
    expect(await harness.call("page_view", { page: given })).toEqual(refused(given))
    expect(await harness.call("terminal", { command: "Write-Output hi", folder: given })).toEqual(refused(given))
  }
})

test("a word of a command that is the root of the drive is not run; PowerShell reads a quoted word and a path stuck to it as two", async () => {
  const roots = ["Write-Output /*.tmp", "Write-Output \\*", "Write-Output /.x", 'Write-Output "x y" /*.tmp']
  for (const commands of [STRICT, SHIPPED])
    for (const command of roots) {
      const answer = await start({ commands }).harness.call("terminal", { command })
      expect([command, answer.failed, answer.text.includes("is outside the project")]).toEqual([command, true, true])
    }
  expect(await start({ commands: STRICT }).call("terminal", { command: 'Write-Output "x y"/*.tmp' })).toStartWith(
    "`/*.tmp` is outside the project.",
  )
})

test("a path of another computer is taken from the project folder, and the answer says so", async () => {
  const taken = "`{{path}}` is not a path of this computer: `{{used}}` in the project folder was used instead."
  const said = (written: string, used: string) =>
    `<system-reminder>
${taken.replace("{{path}}", written).replace("{{used}}", used)}
</system-reminder>`
  const { call, project, file } = start({
    hooks: { "path-taken-from-project": taken },
    files: { "src/app.py": "print(1)\n", "data/orders.csv": "id\n" },
  })
  expect(await call("read", { path: "/workspace/src/app.py" })).toBe(
    `${said("/workspace/src/app.py", "src/app.py")}\nsrc/app.py, lines 1-1 of 1\nprint(1)`,
  )
  expect(await call("write", { path: `/home/user/${path.basename(project)}/notes.txt`, content: "a\n" })).toEndWith(
    "\nWritten notes.txt (1 lines)",
  )
  expect(file("notes.txt")).toBe("a\n")
  expect(await call("read", { path: "/data/orders.csv" })).toStartWith(said("/data/orders.csv", "data/orders.csv"))
  expect(await call("write", { path: "/home/index.html", content: "<title>x</title>" })).toStartWith(
    said("/home/index.html", "index.html"),
  )
  // In a command that runs a program nothing is rewritten: a path of another computer there is a place outside.
  expect(await call("terminal", { command: "python /workspace/src/app.py" })).toStartWith(
    "`/workspace/src/app.py` is outside the project.",
  )
  expect(await call("read", { path: "/c/Users/someone/notes.txt" })).toStartWith("No file ")
  expect(await call("read", { path: "/mnt/c/Users/someone/notes.txt" })).toStartWith("No file ")
})

// A small model believes it is on Linux, with the project at the root (`/mango-test-1`): Mango Harness 2 as it ships
// takes that folder from the project, in a `cd` and as the folder of a command, and says so.
test("Mango Harness 2 takes a folder of another computer from the project, in a cd and as the folder of a command", async () => {
  const project = path.join(ROOT, "mango-test-1")
  fs.mkdirSync(project)
  const harness = openHarness({
    project,
    version: versionOf(BASE),
    web,
    browser: {
      view: async () => new Error("no page"),
      act: async () => ({ title: "", items: [], errors: [] }),
      back: async () => new Error("no page"),
      close: async () => {},
    },
    user: async () => "",
  })
  const inCd = await harness.call("terminal", { command: "cd /mango-test-1 && echo one > one.txt" })
  expect([inCd.failed, inCd.text.includes("`/mango-test-1`")]).toEqual([false, true])
  expect(fs.readFileSync(path.join(project, "one.txt"), "utf8")).toBe("one\n")
  const inFolder = await harness.call("terminal", { command: "echo two > two.txt", folder: "/mango-test-1" })
  expect(inFolder.failed).toBe(false)
  expect(fs.readFileSync(path.join(project, "two.txt"), "utf8")).toBe("two\n")
})

test("write replaces a file that was never read", async () => {
  const { call } = start({ files: { "notes.txt": TEN } })
  expect(await call("write", { path: "notes.txt", content: "new\n" })).toBe("Written notes.txt (1 lines)")
})

test("edit replaces one place, keeps the line ends of the file and shows the lines around", async () => {
  const { call, file } = start({ files: { "list.csv": "name,ext\r\nLaura,280\r\nMarta,140\r\nElena,377\r\n" } })
  expect(await call("edit", { path: "list.csv", old: "Laura,280\nMarta,140", new: "Laura,281\nMarta,141" })).toBe(
    "Changed list.csv. Around the change:\nname,ext\nLaura,281\nMarta,141\nElena,377",
  )
  expect(file("list.csv")).toBe("name,ext\r\nLaura,281\r\nMarta,141\r\nElena,377\r\n")
})

test("edit asks for the old text", async () => {
  const { call } = start({ files: { "a.txt": "x\n" } })
  expect(await call("edit", { path: "a.txt", new: "y" })).toBe("`edit` needs `old`: the text that is in the file now.")
})

test("an old text that is not in the file comes back with the closest lines", async () => {
  const { call } = start({ files: { "list.csv": "name,ext\nLaura Bianchi,280\nMarta De Luca,140\nElena Greco,377\n" } })
  expect(
    await call("edit", { path: "list.csv", old: "Elena Greco,377\n\n(End of file - total 4 lines)", new: "x" }),
  ).toBe(
    "The old text is not in list.csv. The closest lines:\nLaura Bianchi,280\nMarta De Luca,140\nElena Greco,377",
  )
})

test("an old text in several places is refused with their lines, unless every place is asked for", async () => {
  const { call, file } = start({ files: { "a.txt": "red\nblue\nred\n" } })
  expect(await call("edit", { path: "a.txt", old: "red", new: "green" })).toBe(
    "The old text is in 2 places of a.txt, at lines 1, 3. Give more of the text around the one you mean, or `all`.",
  )
  expect(await call("edit", { path: "a.txt", old: "red", new: "green", all: true })).toStartWith(
    "Changed a.txt in 2 places.",
  )
  expect(file("a.txt")).toBe("green\nblue\ngreen\n")
})

test("spaces at the ends of the lines are forgiven only by the harness that says so", async () => {
  const files = { "a.py": "def f():  \n    return 1\n" }
  const one = start({ commands: SHIPPED, files })
  expect(
    await one.call("edit", { path: "a.py", old: "def f():\n    return 1", new: "def f():\n    return 2" }),
  ).toStartWith("Changed a.py.")
  const two = start({ commands: STRICT, files })
  expect(
    await two.call("edit", { path: "a.py", old: "def f():\n    return 1", new: "def f():\n    return 2" }),
  ).toStartWith("The old text is not in a.py.")
})

test("search finds files by name at any depth, lines by text, and says what the project holds when nothing is found", async () => {
  const { call } = start({
    files: {
      "data/orders.csv": "id;total\n4471;318,40\n",
      "data/old/orders-2023.csv": "id;total\n",
      "notes.txt": "Order 4471 is late\n",
    },
  })
  expect(await call("search", { name: "*.csv" })).toBe("data/old/orders-2023.csv\ndata/orders.csv")
  expect(await call("search", { text: "4471" })).toBe("data/orders.csv:2: 4471;318,40\nnotes.txt:1: Order 4471 is late")
  expect(await call("search", { text: "4471", name: "*.csv", folder: "data" })).toBe("data/orders.csv:2: 4471;318,40")
  expect(await call("search", { name: "*.pdf" })).toBe("Nothing found. The project holds:\ndata/\nnotes.txt")
  expect(await call("search", {})).toBe("Give `name`, `text`, or both.")
})

// ---------------------------------------------------------------- the terminal

test("the terminal runs a command and says how it ended", async () => {
  const { harness } = start()
  expect(await harness.call("terminal", { command: "Write-Output hello" })).toEqual({ text: "hello", failed: false })
  const failed = await harness.call("terminal", { command: "Write-Output before; exit 3" })
  expect(failed).toEqual({ text: "before\n\nexit 3", failed: true })
})

test("a harness without bash runs the terminal in PowerShell: the commands of Linux fail as it has them", async () => {
  const linux = await start({ commands: SHIPPED, files: { "notes.txt": "x\n" } }).harness.call("terminal", {
    command: "ls -la 2>/dev/null | head -n 50",
  })
  expect(linux.failed).toBe(true)
  const root = await start({ commands: SHIPPED }).harness.call("terminal", { command: 'find / -name "*.csv" | head' })
  expect([root.failed, root.text.startsWith("`/` is outside the project.")]).toEqual([true, true])
})

// ---------------------------------------------------------------- the terminal in Git Bash

const BASH = { terminal: "bash", commands: SHIPPED } as const

test("the terminal of a harness with bash is Git Bash: the commands of Linux run, and it says how they ended", async () => {
  const { harness } = start({ ...BASH, files: { "notes.txt": "x\n" } })
  const listed = await harness.call("terminal", { command: "ls -la 2>/dev/null | head -n 50" })
  expect([listed.failed, listed.text.includes("notes.txt")]).toEqual([false, true])
  expect(await harness.call("terminal", { command: "echo città; exit 3" })).toEqual({
    text: "città\n\nexit 3",
    failed: true,
  })
  expect(await harness.call("terminal", { command: "true" })).toEqual({ text: "(no output)", failed: false })
  expect(await harness.call("terminal", { command: "nothing-here" })).toEqual({
    text: "bash: line 1: nothing-here: command not found\n\nexit 127",
    failed: true,
  })
  expect((await harness.call("terminal", { command: "Write-Output hi" })).failed).toBe(true)
})

test("in bash every form of a place outside the project is refused, and the shell is not started", async () => {
  const { harness, project } = start(BASH)
  const places = [
    ["cat /c/Users/someone/notes.txt", "/c/Users/someone/notes.txt"],
    ["ls /c", "/c"],
    ["cat C:/Users/someone/notes.txt", "C:/Users/someone/notes.txt"],
    ['cat "C:\\Users\\someone\\my notes.txt"', "C:\\Users\\someone\\my notes.txt"],
    ["ls ~", "~"],
    ["cat ~/notes.txt", "~/notes.txt"],
    ["cat $HOME/notes.txt", "$HOME/notes.txt"],
    ["echo x > /tmp/out.txt", "/tmp/out.txt"],
    ["python /home/user/app/main.py", "/home/user/app/main.py"],
    ["python /app/main.py", "/app/main.py"],
    ["cat /root/.bashrc", "/root/.bashrc"],
    ["cd /root && ls", "/root"],
    ["find / -name '*.csv' | head", "/"],
    ["cat ../outer.txt", "../outer.txt"],
    ['bash -c "cd /root/project && python -m pytest -v 2>&1"', "/root/project"],
    ["ls -la /Users/ -1 2>/dev/null", "/Users/"],
    ["rm -f /*.tmp", "/*.tmp"],
    [`cat ${project.replaceAll("\\", "/")}/../x.txt`, `${project.replaceAll("\\", "/")}/../x.txt`],
  ]
  for (const [command, place] of places) {
    const refused = await harness.call("terminal", { command })
    expect([command, refused.failed, refused.text.startsWith(`\`${place}\` is outside the project.`)]).toEqual([
      command,
      true,
      true,
    ])
  }
  expect(fs.existsSync("/tmp/out.txt") || fs.existsSync("C:\\tmp\\out.txt")).toBe(false)
})

test("in bash a place that is inside the project is run, in any form that names it", async () => {
  const { harness, project, file } = start({ ...BASH, files: { "src/a.txt": "one\n" } })
  const inside = project.replaceAll("\\", "/")
  const drive = `/${inside[0].toLowerCase()}${inside.slice(2)}`
  expect(await harness.call("terminal", { command: `cat ${inside}/src/a.txt` })).toEqual({ text: "one", failed: false })
  expect(await harness.call("terminal", { command: `cat ${drive}/src/a.txt` })).toEqual({ text: "one", failed: false })
  expect(await harness.call("terminal", { command: "echo two > src/b.txt; cat ./src/b.txt 2>/dev/null" })).toEqual({
    text: "two",
    failed: false,
  })
  expect(file("src/b.txt")).toBe("two\n")
})

test("in bash a folder the user named is written through its bash form, and no other", async () => {
  const named = path.join(ROOT, "named-out")
  fs.mkdirSync(named, { recursive: true })
  const { harness } = start(BASH)
  harness.message(`Write the result in ${named}`)
  const form = `/${named[0].toLowerCase()}${named.slice(2).replaceAll("\\", "/")}`
  expect(await harness.call("terminal", { command: `echo hi > ${form}/x.txt` })).toEqual({
    text: "(no output)",
    failed: false,
  })
  expect(fs.readFileSync(path.join(named, "x.txt"), "utf8")).toBe("hi\n")
  expect((await harness.call("terminal", { command: `echo hi > ${form}-other/x.txt` })).text).toStartWith(
    `\`${form}-other/x.txt\` is outside the project.`,
  )
})

test("in bash a quoted folder with a wildcard glued to it is one word", async () => {
  const { harness, project } = start({
    ...BASH,
    files: { "già fatti/a.tmp": "a", "già fatti/keep.txt": "k", "b.tmp": "b" },
  })
  expect(await harness.call("terminal", { command: 'echo "x y"/*.tmp' })).toEqual({ text: "x y/*.tmp", failed: false })
  expect(await harness.call("terminal", { command: 'rm -f "./già fatti"/*.tmp' })).toEqual({
    text: "(no output)",
    failed: false,
  })
  expect(fs.readdirSync(path.join(project, "già fatti"))).toEqual(["keep.txt"])
  expect(fs.existsSync(path.join(project, "b.tmp"))).toBe(true)
  const root = await harness.call("terminal", { command: "echo /*.tmp" })
  expect([root.failed, root.text.startsWith("`/*.tmp` is outside the project.")]).toEqual([true, true])
})

test("in bash a file command runs in the shell as written, and a cmdlet of PowerShell is not known to it", async () => {
  const { call } = start({ ...BASH, files: { "notes.txt": "one\n", "src/app.js": "let wifi = 1\n" } })
  expect(await call("terminal", { command: "cat notes.txt" })).toBe("one")
  expect(await call("terminal", { command: "Get-Content -Path src/app.js" })).toBe(
    "bash: line 1: Get-Content: command not found\n\nexit 127",
  )
})

test("in bash a change of folder is refused, and one in front of a command is the folder it runs in", async () => {
  const { call } = start({
    ...BASH,
    hooks: { "cd-in-terminal": "Not run: give `folder`. The project holds:\n{{listing}}" },
    files: { "src/app.js": "x" },
  })
  expect(await call("terminal", { command: "cd src" })).toBe("Not run: give `folder`. The project holds:\nsrc/")
  expect(await call("terminal", { command: 'cd src && basename "$PWD"' })).toBe("src")
  expect(await call("terminal", { command: 'basename "$PWD"', folder: "src" })).toBe("src")
})

test("a command in bash too long for Windows is refused with a sentence, and the terminal still works after it", async () => {
  const { harness } = start(BASH)
  const command = `echo start # ${"x".repeat(40_000)}`
  const answer = await harness.call("terminal", { command })
  expect(answer.failed).toBe(true)
  expect(answer.text).toBe("A command of 40,013 characters is more than bash takes. Split it into shorter commands.")
  expect(await harness.call("terminal", { command: "echo again" })).toEqual({ text: "again", failed: false })
})

test("a command in bash is stopped when its timeout is over, and says after how long", async () => {
  const { harness } = start(BASH)
  const answer = await harness.call("terminal", { command: "echo started; sleep 30", timeout: 2 })
  expect(answer.failed).toBe(true)
  expect(answer.text).toBe("started\n\nStopped after 2 seconds. To wait longer give `timeout`, up to 600 seconds.")
  expect(await harness.call("terminal", { command: "echo hi", timeout: "soon" })).toEqual({
    text: "`timeout` must be a whole number, 1 or more.",
    failed: true,
  })
}, 20_000)

// ---------------------------------------------------------------- the tool powershell

test("the tool powershell runs a script in Windows PowerShell 5.1, in the project folder, and says how it ended", async () => {
  const { harness, project } = start({ ...BASH, files: { "a.txt": "x\n" } })
  expect(await harness.call("powershell", { script: "Write-Output hello" })).toEqual({ text: "hello", failed: false })
  expect(await harness.call("powershell", { script: "Write-Output before; exit 3" })).toEqual({
    text: "before\n\nexit 3",
    failed: true,
  })
  expect((await harness.call("powershell", { script: "$PSVersionTable.PSVersion.Major" })).text).toMatch(/^\d+$/)
  const where = (await harness.call("powershell", { script: "(Get-Location).Path" })).text
  expect(where.toLowerCase()).toBe(fs.realpathSync.native(project).toLowerCase())
  expect(await harness.call("powershell", { script: "Write-Output 'città è già'" })).toEqual({
    text: "città è già",
    failed: false,
  })
  const failed = await harness.call("powershell", { script: "Get-Item nothing-here.txt" })
  expect(failed.failed).toBe(true)
  expect(failed.text).toMatch(
    /^Get-Item: Cannot find path '.*nothing-here\.txt' because it does not exist\.\n\nexit 1$/,
  )
  expect(await harness.call("powershell", {})).toEqual({ text: "`powershell` needs `script`.", failed: true })
})

test("the tool powershell is not read as the terminal is: a cmdlet that shows a file shows it, a change of folder runs", async () => {
  const { call } = start({
    ...BASH,
    hooks: { "cd-in-terminal": "Not run: give `folder`." },
    files: { "a.txt": "x\n" },
  })
  expect(await call("powershell", { script: "Get-Content a.txt" })).toBe("x")
  expect(await call("powershell", { script: "Set-Location .; Write-Output moved" })).toBe("moved")
})

test("a script that names a place outside the project is not run, in the forms of PowerShell", async () => {
  const { harness } = start({ ...BASH, files: { "a.txt": "x\n" } })
  const places = [
    ["Get-Content C:\\Windows\\win.ini", "C:\\Windows\\win.ini"],
    ["Get-Content C:/Windows/win.ini", "C:/Windows/win.ini"],
    ["Get-ChildItem ~", "~"],
    ["Copy-Item a.txt $env:TEMP\\a.txt", "$env:TEMP\\a.txt"],
    ["Get-Content ..\\outer.txt", "..\\outer.txt"],
    ["Get-ChildItem C:\\ -Recurse", "C:\\"],
    ["Get-ChildItem \\\\server\\share", "\\\\server\\share"],
    ["Set-Content /tmp/out.txt hi", "/tmp/out.txt"],
    ["Get-Content %APPDATA%\\x.txt", "%APPDATA%\\x.txt"],
  ]
  for (const [script, place] of places) {
    const refused = await harness.call("powershell", { script })
    expect([script, refused.failed, refused.text.startsWith(`\`${place}\` is outside the project.`)]).toEqual([
      script,
      true,
      true,
    ])
  }
  expect(await harness.call("powershell", { script: "Write-Output /c /all" })).toEqual({
    text: "/c\n/all",
    failed: false,
  })
})

test("the tool powershell sends a page to the browser, and asks before it loses files", async () => {
  const hooks = { "web-in-terminal": "Not run: open {{url}} with `page_view`.", ...LOSE }
  const { call, project, asked } = start({
    ...BASH,
    hooks,
    files: { "bozze/bozza-1.txt": "Titolo 1\n" },
  })
  await call("web_search", { query: "lanterna" })
  expect(await call("powershell", { script: "Invoke-WebRequest https://lanterna.example/blog/2-0" })).toBe(
    "Not run: open https://lanterna.example/blog/2-0 with `page_view`.",
  )
  expect(await call("powershell", { script: "Remove-Item -Recurse bozze" })).toStartWith(
    "Not done, it would lose:\n- `bozze/bozza-1.txt`, deleted",
  )
  expect(fs.existsSync(path.join(project, "bozze", "bozza-1.txt"))).toBe(true)
  expect(asked).toHaveLength(1)
})

test("Mango Harness 2 sends the terminal in Git Bash and, right after it, the tool powershell", () => {
  const version = versionOf(Harness.definition("mango-harness-2"))
  const tools = version.declarations(version.startingTools()).map((tool) => tool.function.name)
  const seeing = versionOf(Harness.definition("mango-harness-2"), { vision: true })
  expect(seeing.declarations(seeing.startingTools()).map((tool) => tool.function.name)).toEqual([
    "skill",
    "terminal",
    "powershell",
    "read",
    "write",
    "edit",
    "search",
    "web_search",
    "web_open",
    "page_view",
    "page_look",
    "page_act",
    "ask",
    "plan",
  ])
  expect(tools).toEqual([
    "skill",
    "terminal",
    "powershell",
    "read",
    "write",
    "edit",
    "search",
    "web_search",
    "web_open",
    "page_view",
    "page_act",
    "ask",
    "plan",
  ])
  const said = Object.fromEntries(
    version.declarations(["terminal", "powershell"]).map((tool) => [tool.function.name, tool.function]),
  )
  expect(said.terminal.description).toContain("bash (Git Bash on Windows)")
  expect(said.terminal.description).not.toContain("PowerShell")
  expect(Object.keys((said.powershell.parameters as { properties: object }).properties)).toEqual(["script", "timeout"])
  expect(said.powershell.description).toContain("Windows PowerShell 5.1 script on Windows")
  expect(said.powershell.description).toContain("services, the registry, Word or Excel automation")
  const prompt = version.system("/projects/archivio-clienti")
  expect(prompt).toContain("on Windows")
  expect(prompt).toContain("A block between `<system-reminder>` tags in an answer comes from the harness")
  expect(prompt).toContain("`terminal`. It is Git Bash.")
  expect(prompt).toContain("`powershell`")
  expect(prompt).not.toContain("It is PowerShell")
  expect(version.meta.terminal).toBe("bash")
})

test("a change of folder is refused, and one in front of a command becomes the folder it runs in", async () => {
  const { call } = start({
    hooks: { "cd-in-terminal": "Not run: give `folder`. The project holds:\n{{listing}}" },
    files: { "src/app.js": "x" },
  })
  expect(await call("terminal", { command: "cd src" })).toBe("Not run: give `folder`. The project holds:\nsrc/")
  expect(await call("terminal", { command: "cd src && (Get-Location | Split-Path -Leaf)" })).toBe("src")
  expect(await call("terminal", { command: "Get-Location | Split-Path -Leaf", folder: "src" })).toBe("src")
})

test("a command that names a place outside the project is not run", async () => {
  const { call, project } = start({ files: { "a.txt": "x" } })
  expect(await call("terminal", { command: "python /workspace/run.py | Out-String" })).toStartWith(
    "`/workspace/run.py` is outside the project.",
  )
  expect(await call("terminal", { command: `Test-Path "${path.join(project, "a.txt")}" | Out-String` })).toBe("True")
  expect(await call("terminal", { command: "Write-Output /c /all" })).toBe("/c\n/all")
})

test("a command in PowerShell is stopped when its timeout is over", async () => {
  const { harness } = start()
  const answer = await harness.call("terminal", { command: "Write-Output started; Start-Sleep 30", timeout: 2 })
  expect(answer.failed).toBe(true)
  expect(answer.text).toBe("started\n\nStopped after 2 seconds. To wait longer give `timeout`, up to 600 seconds.")
}, 20_000)

// ---------------------------------------------------------------- what an answer holds back, and what it says

test("read keeps an answer to 20,000 characters and says how much was left out and where to read on", async () => {
  const lines = Array.from({ length: 100 }, (_, i) => `${String(i + 1).padStart(3, "0")} ${"x".repeat(496)}`)
  const { call } = start({ files: { "big.txt": lines.join("\n") } })
  const first = (await call("read", { path: "big.txt" })).split("\n")
  expect(first[0]).toBe("big.txt, lines 1-39 of 100")
  expect(first.length).toBe(1 + 39 + 1)
  expect(first.at(-1)).toBe(
    "… 61 more lines (30561 characters) left out to keep the answer short: read on from line 40",
  )
  expect((await call("read", { path: "big.txt", from: 40, lines: 2 })).split("\n")[0]).toBe(
    "big.txt, lines 40-41 of 100",
  )
})

test("a file that is not text is not read, edited or searched", async () => {
  const { call, project } = start({ files: { "notes.txt": "find me\n" } })
  fs.writeFileSync(
    path.join(project, "a.bin"),
    Buffer.from([0x66, 0x69, 0x6e, 0x64, 0x20, 0x6d, 0x65, 0x00, 0x01, 0x02]),
  )
  fs.writeFileSync(
    path.join(project, "b.dat"),
    Buffer.from([0x80, 0x81, 0x01, 0x02, 0x03, 0xfe, 0x66, 0x69, 0x6e, 0x64]),
  )
  expect(await call("read", { path: "a.bin" })).toBe("a.bin is a binary file, not text: it cannot be read.")
  expect(await call("read", { path: "b.dat" })).toBe("b.dat is a binary file, not text: it cannot be read.")
  expect(await call("edit", { path: "a.bin", old: "find", new: "x" })).toBe(
    "a.bin is a binary file, not text: it cannot be edited.",
  )
  expect(await call("search", { text: "find" })).toBe("notes.txt:1: find me")
  // Text in another encoding is still text.
  fs.writeFileSync(path.join(project, "latin.txt"), Buffer.from("caffè\n", "latin1"))
  expect(await call("read", { path: "latin.txt" })).toBe("latin.txt, lines 1-1 of 1\ncaffè")
})

test("search by text finds the lines of a folder outside the project, which may be read", async () => {
  const outer = fs.mkdtempSync(path.join(ROOT, "outer-"))
  fs.writeFileSync(path.join(outer, "log.txt"), "first\nNeedle here\n")
  const { call } = start({ files: { "a.txt": "x\n" } })
  expect(await call("search", { text: "needle", folder: outer })).toBe(`${path.join(outer, "log.txt")}:2: Needle here`)
  expect(await call("search", { text: "needle", name: "*.txt", folder: outer })).toContain("log.txt:2: Needle here")
})

test("an argument the command does not have is said to be ignored", async () => {
  const { harness } = start({ files: { "a.txt": "x\n" } })
  expect((await harness.call("read", { path: "a.txt", colour: "red" })).text).toEndWith(
    "\nx\n\nIgnored: `colour` is not an argument of `read`.",
  )
  expect((await harness.call("read", { path: "a.txt", colour: "red", mode: "fast" })).text).toEndWith(
    "Ignored: `colour`, `mode` are not arguments of `read`.",
  )
  expect((await harness.call("read", { path: "missing.txt", colour: "red" })).text).toEndWith(
    "\n\nIgnored: `colour` is not an argument of `read`.",
  )
  expect((await harness.call("read", { path: "a.txt", from: "" })).text).not.toContain("Ignored")
})

// ---------------------------------------------------------------- the hooks

test("a call that failed and comes again unchanged is refused without being run; one that worked runs again", async () => {
  const { harness, call } = start({ files: { "a.txt": "x\n" } })
  await call("read", { path: "missing.txt" })
  expect(await harness.call("read", { path: "missing.txt" })).toEqual({
    text: "Same call as before: not run.",
    failed: true,
  })
  expect(await call("read", { path: "a.txt" })).toBe(await call("read", { path: "a.txt" }))
  await call("read", { path: "missing.txt" })
  harness.message("Try again, I have just made it.")
  expect(await call("read", { path: "missing.txt" })).toStartWith("No file missing.txt.")
})

test("what the harness adds after a failed call and every so many calls", async () => {
  const { call } = start({
    hooks: { "after-failed-call": "Change the command.", "every-3-calls": "You have made {{calls}} calls." },
    files: { "a.txt": "x\n" },
  })
  expect(await call("read", { path: "missing.txt" })).toEndWith(
    "\n\n<system-reminder>\nChange the command.\n</system-reminder>",
  )
  expect(await call("read", { path: "a.txt" })).toBe("a.txt, lines 1-1 of 1\nx")
  expect(await call("read", { path: "a.txt" })).toEndWith(
    "\n\n<system-reminder>\nYou have made 3 calls.\n</system-reminder>",
  )
})

test("skill opens a method, and an unknown name comes with the list", async () => {
  const { call } = start()
  expect(await call("skill", { name: "planning" })).toBe("THE METHOD OF PLANNING")
  expect(await call("skill", { name: "skill web-research" })).toBe("THE METHOD OF WEB-RESEARCH")
  expect(await call("skill", { name: "cooking" })).toBe(
    "No skill named cooking. The skills are: debugging, planning, web-research.",
  )
})

test("the rules come with every message", async () => {
  const always = start({ reminder: "<rules>always</rules>" })
  expect([always.harness.message("a"), always.harness.message("b")]).toEqual([
    "a\n\n<rules>always</rules>",
    "b\n\n<rules>always</rules>",
  ])
})

test("a hook the code does not know, or a value it does not give, stops the harness from opening", () => {
  expect(() => start({ hooks: { "after-lunch": "Rest." } })).toThrow("after-lunch")
  expect(() => start({ hooks: { "after-failed-call": "You made {{calls}} calls." } })).toThrow("{{calls}}")
})

// ---------------------------------------------------------------- the plan

const PLAN =
  "# Goal\nA page with the opening hours.\n# What is there\nindex.html, 40 lines.\n## Step 1: the table\nAdd a table to index.html.\nCheck: the page shows 7 rows.\n## Step 2: the style\nColour the header in style.css.\n# Not doing\nNo new pages."

test("a plan is kept, each step done gives the next one whole, and a step can be rewritten or added", async () => {
  const { call } = start()
  expect(await call("plan", {})).toBe("No plan yet")
  expect(await call("plan", { text: PLAN })).toBe(
    "Plan kept, 2 steps:\n1. [ ] the table\n2. [ ] the style\n\n## Step 1: the table\nAdd a table to index.html.\nCheck: the page shows 7 rows.",
  )
  expect(await call("plan", { done: 1 })).toBe(
    "Goal: A page with the opening hours.\n1. [x] the table\n2. [ ] the style\n\n## Step 2: the style\nColour the header in style.css.",
  )
  expect(await call("plan", { step: 1, text: "## Step 1: the table, again\nSeven rows and a caption." })).toBe(
    "1. [ ] the table, again\n2. [ ] the style\n\n## Step 1: the table, again\nSeven rows and a caption.",
  )
  expect(await call("plan", { step: 3, text: "Publish it." })).toBe(
    "1. [ ] the table, again\n2. [ ] the style\n3. [ ] Publish it.\n\n## Step 3: Publish it.",
  )
  expect(await call("plan", { step: 5, text: "Too far." })).toBe(
    "There is no step 5, and the next free one is 4. The steps are:\n1. [ ] the table, again\n2. [ ] the style\n3. [ ] Publish it.",
  )
  expect(await call("plan", { done: 9 })).toStartWith("There is no step 9. The steps are:")
  await call("plan", { done: 1 })
  await call("plan", { done: 2 })
  expect(await call("plan", { done: 3 })).toBe(
    "Goal: A page with the opening hours.\n1. [x] the table, again\n2. [x] the style\n3. [x] Publish it.\n\nAll steps done. Read the goal and Not doing once more, then answer the user",
  )
  expect(await call("plan", {})).toContain("# Not doing\nNo new pages.")
})

test("a text without steps is refused with the form", async () => {
  const { call } = start()
  expect(await call("plan", { text: "First the table, then the style." })).toStartWith(
    "A plan needs its steps, each under a `## Step N: title` line. The form:\n# Goal",
  )
})

test("the reminder of the open steps comes every so many calls while the plan is open", async () => {
  const { call } = start({ hooks: { "plan-open-every-2-calls": "Open:\n{{open_steps}}" } })
  expect(await call("plan", { text: PLAN })).not.toContain("Open:")
  expect(await call("plan", { done: 1 })).toEndWith("\n\n<system-reminder>\nOpen:\n2. the style\n</system-reminder>")
})

// ---------------------------------------------------------------- the web, the page, the user

test("a search gives its results", async () => {
  const { call } = start()
  const results =
    "1. Lanterna 2.0 is out\n   https://lanterna.example/blog/2-0\n   2026-10-01\n   The new release of Lanterna."
  expect(await call("web_search", { query: "lanterna release" })).toBe(results)
  expect(await call("web_search", { query: "offline" })).toBe("The web cannot be reached.")
})

test("a page is opened only at an address that was seen", async () => {
  const files = { "links.txt": "See https://lanterna.example/docs for the rest.\n" }
  const two = start({ files })
  expect(await two.call("web_open", { url: "https://lanterna.example/blog/2-0" })).toBe(
    "That address is in no result of a search and in no message. `web_search` first, then open a result.",
  )
  expect(await two.call("web_open", { url: "ftp://lanterna.example" })).toBe(
    "Give an address that starts with http:// or https://.",
  )
  await two.call("web_search", { query: "lanterna" })
  expect(await two.call("web_open", { url: "https://lanterna.example/blog/2-0" })).toBe(
    "Lanterna 2.0 is out\n2026-10-01\n\nLanterna 2.0 adds a dark theme.\nIt was released on 1 October.",
  )
  await two.call("read", { path: "links.txt" })
  expect(await two.call("web_open", { url: "https://lanterna.example/docs" })).toStartWith(
    "That address is in no result",
  )
  two.harness.message("Read https://lanterna.example/docs and tell me")
  expect(await two.call("web_open", { url: "https://lanterna.example/docs" })).toStartWith("Lanterna 2.0 is out")
})

test("the user's own skills are listed after those of the harness and open with the same command", async () => {
  const base =
    "Work well.\n\n# Skills\n- `skill planning`       Before a long job.\n- `skill debugging`      An error.\n\nThe end."
  const skills = [{ name: "minutes", description: "The minutes of a meeting", body: "The minutes go in minutes/." }]
  const { harness, call } = start({ base, skills })
  expect(harness.system()).toEqual([
    "Work well.\n\n# Skills\n- `skill planning`       Before a long job.\n- `skill debugging`      An error.\n- `skill minutes`        The minutes of a meeting\n\nThe end.",
  ])
  expect(await call("skill", { name: "minutes" })).toBe("The minutes go in minutes/.")
  expect(await call("skill", { name: "planning" })).toBe("THE METHOD OF PLANNING")
  expect(await call("skill", { name: "invoices" })).toBe(
    "No skill named invoices. The skills are: debugging, minutes, planning, web-research.",
  )
  expect(start({ base }).harness.system()).toEqual([base])
  expect(() => start({ skills }).harness.system()).toThrow("lists no skill")
})

test("a skill of the user's named like one of the harness is listed once, with the user's words, and opens the user's text", async () => {
  const base =
    "Work well.\n\n# Skills\n- `skill planning`       Before a long job.\n- `skill debugging`      An error.\n\nThe end."
  const skills = [{ name: "debugging", description: "How we chase errors here", body: "The house method." }]
  const { harness, call } = start({ base, skills })
  expect(harness.system()).toEqual([
    "Work well.\n\n# Skills\n- `skill planning`       Before a long job.\n- `skill debugging`      How we chase errors here\n\nThe end.",
  ])
  expect(await call("skill", { name: "debugging" })).toBe("The house method.")
})

test("an answer after search results with no page opened is held back once", async () => {
  const hooks = { "answer-without-opening": "Open the page of the source." }
  const read = start({ hooks })
  expect(read.harness.answer()).toBeUndefined()
  await read.call("web_search", { query: "offline" })
  expect(read.harness.answer()).toBeUndefined()
  await read.call("web_search", { query: "lanterna" })
  expect(read.harness.answer()).toBe("Open the page of the source.")
  expect(read.harness.answer()).toBeUndefined()
  const opened = start({ hooks })
  await opened.call("web_search", { query: "lanterna" })
  await opened.call("web_open", { url: "https://lanterna.example/blog/2-0" })
  expect(opened.harness.answer()).toBeUndefined()
  const off = start()
  await off.call("web_search", { query: "lanterna" })
  expect(off.harness.answer()).toBeUndefined()
})

const LOSE = { "would-lose": "Not done, it would lose:\n{{what}}\nThe user: {{answer}}" }

test("a loss the request orders, naming the files or their kind and saying to delete or rewrite them, is not asked about", async () => {
  const TOLD: Commands = { ...SHIPPED, told: true }
  const files = { "lavoro/cache.tmp": "temporaneo\n", "lavoro/copia.tmp": "temporaneo\n", "note.txt": "uno\ndue\n" }
  const by = async (request: string, command: string, commands = TOLD) => {
    const one = start({ commands, hooks: LOSE, files })
    one.harness.message(request)
    return { text: await one.call("terminal", { command }), asked: one.asked }
  }
  const named = await by(
    "Togli cache.tmp, copia.tmp da lavoro, sono scarti.",
    "Remove-Item lavoro\\cache.tmp, lavoro\\copia.tmp",
  )
  expect(named.text).not.toContain("would lose")
  expect(named.asked).toEqual([])
  const stems = await by(
    "Togli cache e copia dalla cartella lavoro.",
    "Remove-Item lavoro\\cache.tmp, lavoro\\copia.tmp",
  )
  expect(stems.asked).toEqual([])
  const kind = await by("Cancella i file .tmp della cartella lavoro.", "Remove-Item lavoro\\*.tmp")
  expect(kind.asked).toEqual([])
  // Nothing in the request picks out the files: the user is asked.
  expect((await by("Pulisci la cartella lavoro.", "Remove-Item -Recurse lavoro")).asked).toHaveLength(1)
  // The files named, but nothing said of deleting them.
  expect((await by("Guarda cache.tmp e copia.tmp in lavoro.", "Remove-Item lavoro\\*.tmp")).asked).toHaveLength(1)
  // A short name is not found in any word of the sentence: `a` of `a.txt`.
  const short = start({ commands: TOLD, hooks: LOSE, files: { "a.txt": "uno\n" } })
  short.harness.message("Cancella i file vecchi a partire da gennaio.")
  await short.call("terminal", { command: "Remove-Item a.txt" })
  expect(short.asked).toHaveLength(1)
  // A harness without it asks as before.
  expect((await by("Togli cache.tmp, copia.tmp da lavoro.", "Remove-Item lavoro\\*.tmp", SHIPPED)).asked).toHaveLength(1)

  const rewrite = start({ commands: TOLD, hooks: LOSE, files })
  rewrite.harness.message("Riscrivi note.txt da capo con la riga «tre».")
  expect(await rewrite.call("write", { path: "note.txt", content: "tre\n" })).toBe("Written note.txt (1 lines)")
  expect(rewrite.asked).toEqual([])
  // Adding to a file is not rewriting it: a write that loses its lines is asked about.
  const adding = start({ commands: TOLD, hooks: LOSE, files })
  adding.harness.message("Aggiungi la riga «tre» a note.txt.")
  await adding.call("write", { path: "note.txt", content: "tre\n" })
  expect(adding.asked).toHaveLength(1)
  // Deleting is not rewriting: a request to delete a file does not let a write lose the lines of another kind.
  const deleting = start({ commands: TOLD, hooks: LOSE, files })
  deleting.harness.message("Cancella note.txt e scrivi un riepilogo.")
  await deleting.call("write", { path: "note.txt", content: "riepilogo\n" })
  expect(deleting.asked).toHaveLength(1)
})

test("a write that loses lines the project had is not done: the harness asks the user and the model gets the answer", async () => {
  const listino = "Caffè: 1,20 euro\nTè: 1,50 euro\nToast: 3,00 euro\n"
  const { call, file, asked } = start({ commands: SHIPPED, hooks: LOSE, files: { "listino.txt": listino } })
  const what = "- `listino.txt`, written over: 3 lines, «Caffè: 1,20 euro» «Tè: 1,50 euro» …"
  expect(await call("write", { path: "listino.txt", content: "Caffè: 1,30 euro\n" })).toBe(
    `Not done, it would lose:\n${what}\nThe user: the second`,
  )
  expect(asked).toEqual([`This would lose:\n${what}\nGo ahead? []`])
  // Stopped to ask is not a failure of the model's.
  expect(
    (
      await start({ commands: SHIPPED, hooks: LOSE, files: { "a.txt": "uno\n" } }).harness.call("write", {
        path: "a.txt",
        content: "due\n",
      })
    ).failed,
  ).toBe(false)
  expect(file("listino.txt")).toBe(listino)
  // The user has been asked: from now on the model does what it decides.
  expect(await call("write", { path: "listino.txt", content: "Caffè: 1,30 euro\n" })).toBe(
    "Written listino.txt (1 lines)",
  )
  expect(asked).toHaveLength(1)
})

test("adding to a file, writing over a file of the model's own, or a harness without the hook: nothing is asked", async () => {
  const { call, asked } = start({ commands: SHIPPED, hooks: LOSE, files: { "note.txt": "uno\n" } })
  expect(await call("write", { path: "Note.txt", content: "uno\ndue\n" })).toBe("Written Note.txt (2 lines)")
  expect(await call("write", { path: "nuovo.txt", content: "a\n" })).toBe("Written nuovo.txt (1 lines)")
  expect(await call("write", { path: "nuovo.txt", content: "b\n" })).toBe("Written nuovo.txt (1 lines)")
  expect(await call("write", { path: "note.txt", content: "tre\n" })).toBe("Written note.txt (1 lines)")
  expect(asked).toEqual([])
  const off = start({ commands: SHIPPED, files: { "note.txt": "uno\n" } })
  expect(await off.call("write", { path: "note.txt", content: "due\n" })).toBe("Written note.txt (1 lines)")
  expect(off.asked).toEqual([])
})

test("a command of the terminal that would lose files of the project is undone before the user is asked", async () => {
  const files = { "bozze/bozza-1.txt": "Titolo 1\n", "bozze/bozza-2.txt": "Titolo 2\n" }
  const removed = start({ commands: SHIPPED, hooks: LOSE, files })
  const there = (name: string) => fs.existsSync(path.join(removed.project, name))
  expect(await removed.call("terminal", { command: "Remove-Item -Recurse bozze" })).toBe(
    "Not done, it would lose:\n- `bozze/bozza-1.txt`, deleted: 1 lines, «Titolo 1»\n- `bozze/bozza-2.txt`, deleted: 1 lines, «Titolo 2»\nThe user: the second",
  )
  expect(there("bozze/bozza-1.txt") && there("bozze/bozza-2.txt")).toBe(true)
  expect(await removed.call("terminal", { command: "rm -r bozze" })).not.toContain("would lose")
  expect(there("bozze")).toBe(false)

  const copied = start({
    commands: SHIPPED,
    hooks: LOSE,
    files: { "nuovi/verbale.txt": "nuova\n", "nuovi/ordine.txt": "nuovo\n", "archivio/verbale.txt": "vecchia\n" },
  })
  const inArchive = (name: string) => path.join(copied.project, "archivio", name)
  // A copy that overwrites nothing is not asked about.
  expect(await copied.call("terminal", { command: "Copy-Item nuovi/ordine.txt archivio/" })).not.toContain("would lose")
  expect(fs.existsSync(inArchive("ordine.txt"))).toBe(true)
  fs.rmSync(inArchive("ordine.txt"))
  expect(await copied.call("terminal", { command: "Copy-Item nuovi/* archivio/" })).toStartWith(
    "Not done, it would lose:\n- `archivio/verbale.txt`, written over: 1 lines, «vecchia»",
  )
  expect(fs.readFileSync(inArchive("verbale.txt"), "utf8")).toBe("vecchia\n")
  expect(fs.existsSync(inArchive("ordine.txt"))).toBe(false)
  expect(copied.asked).toHaveLength(1)
})

test("a command of bash that would lose files of the project is undone before the user is asked", async () => {
  const files = {
    "bozze/bozza-1.txt": "Titolo 1\n",
    "nuovi/verbale.txt": "nuova\n",
    "archivio/verbale.txt": "vecchia\n",
    "note.txt": "uno\ndue\n",
  }
  const one = start({ ...BASH, hooks: LOSE, files })
  const kept = (name: string) => fs.readFileSync(path.join(one.project, name), "utf8")
  expect(await one.call("terminal", { command: "rm -rf bozze" })).toStartWith(
    "Not done, it would lose:\n- `bozze/bozza-1.txt`, deleted: 1 lines, «Titolo 1»",
  )
  expect(kept("bozze/bozza-1.txt")).toBe("Titolo 1\n")
  expect(await one.call("terminal", { command: "cp nuovi/* archivio/" })).not.toContain("would lose")
  expect(kept("archivio/verbale.txt")).toBe("nuova\n")
  expect(one.asked).toHaveLength(1)

  const edited = start({ ...BASH, hooks: LOSE, files })
  expect(await edited.call("terminal", { command: "sed -i 's/uno//;s/due//' note.txt" })).toStartWith(
    "Not done, it would lose:\n- `note.txt`, written over",
  )
  expect(fs.readFileSync(path.join(edited.project, "note.txt"), "utf8")).toBe("uno\ndue\n")
  const redirected = start({ ...BASH, hooks: LOSE, files })
  expect(await redirected.call("terminal", { command: "echo corto > note.txt" })).toStartWith(
    "Not done, it would lose:",
  )
})

test("a page fetched from bash is not: it is opened with the browser", async () => {
  const { harness, call } = start({ ...BASH, hooks: { "web-in-terminal": "Not run: open {{url}} with `page_view`." } })
  harness.message("Book the room on the site http://127.0.0.1:5000.")
  expect(await call("terminal", { command: "curl -s http://127.0.0.1:5000/sale/prenota?slot=3" })).toBe(
    "Not run: open http://127.0.0.1:5000/sale/prenota?slot=3 with `page_view`.",
  )
  expect(await call("terminal", { command: "wget -qO- http://127.0.0.1:5000/" })).toStartWith("Not run:")
  expect(await call("terminal", { command: "curl -s http://127.0.0.1:5999/ 2>/dev/null; echo done" })).toContain("done")
})

test("a file moved elsewhere is not lost; a folder put back keeps its name, and a large file is left alone", async () => {
  const moved = start({ commands: SHIPPED, hooks: LOSE, files: { "note.txt": "uno\n", "archivio/vecchio.txt": "x\n" } })
  expect(await moved.call("terminal", { command: "Move-Item note.txt archivio/" })).not.toContain("would lose")
  expect(fs.existsSync(path.join(moved.project, "archivio", "note.txt"))).toBe(true)
  expect(moved.asked).toEqual([])

  const large = "riga\n".repeat(250_000)
  const folder = start({
    commands: SHIPPED,
    hooks: LOSE,
    files: { "Bozze/bozza-1.txt": "Titolo 1\n", "dati.csv": large },
  })
  expect(
    await folder.call("terminal", { command: "Remove-Item -Recurse Bozze; Set-Content dati.csv corto" }),
  ).toStartWith("Not done, it would lose:\n- `Bozze/bozza-1.txt`, deleted")
  expect(fs.readdirSync(folder.project)).toContain("Bozze")
  // Too large to be kept: what the command did to it stays, and it is not taken for a file the command made.
  expect(fs.readFileSync(path.join(folder.project, "dati.csv"), "utf8").trim()).toBe("corto")
})

test("once the model has asked the user, or the user has written again, the harness asks nothing", async () => {
  const model = start({ commands: SHIPPED, hooks: LOSE, files: { "note.txt": "uno\n" } })
  await model.call("ask", { question: "Shall I write over it?" })
  expect(await model.call("write", { path: "note.txt", content: "due\n" })).toBe("Written note.txt (1 lines)")
  expect(model.asked).toEqual(["Shall I write over it? []"])
  const told = start({ commands: SHIPPED, hooks: LOSE, files: { "note.txt": "uno\n" } })
  told.harness.message("Riscrivi note.txt.")
  told.harness.message("Yes, go ahead.")
  expect(await told.call("write", { path: "note.txt", content: "due\n" })).toBe("Written note.txt (1 lines)")
  expect(told.asked).toEqual([])
})

test("a page the user named, or a search found, fetched from the terminal is not: it is opened with the browser", async () => {
  const hooks = { "web-in-terminal": "Not run: open {{url}} with `page_view`." }
  const { harness, call } = start({ commands: SHIPPED, hooks })
  harness.message("Book the room on the site http://127.0.0.1:5000.")
  expect(await call("terminal", { command: "curl -s http://127.0.0.1:5000/sale/prenota?slot=3" })).toBe(
    "Not run: open http://127.0.0.1:5000/sale/prenota?slot=3 with `page_view`.",
  )
  expect(
    await call("terminal", {
      command: `python -c "import requests; print(requests.get('http://127.0.0.1:5000/').text)"`,
    }),
  ).toStartWith("Not run:")
  await call("web_search", { query: "lanterna" })
  expect(await call("terminal", { command: "Invoke-WebRequest https://lanterna.example/blog/2-0" })).toStartWith(
    "Not run:",
  )
  // An address nobody gave, as that of a server the model started itself, is the terminal's.
  expect(
    await call("terminal", {
      command: "try { Invoke-WebRequest http://127.0.0.1:5999/ -UseBasicParsing -TimeoutSec 2 } catch {}; echo done",
    }),
  ).toContain("done")
  const off = start({ commands: SHIPPED })
  off.harness.message("Book the room on the site http://127.0.0.1:5000.")
  expect(
    await off.call("terminal", {
      command: "try { Invoke-WebRequest http://127.0.0.1:5000/ -UseBasicParsing -TimeoutSec 2 } catch {}; echo done",
    }),
  ).toContain("done")
  // Two shells start cold here: under a full parallel run that alone can pass the default 5 s.
}, 20_000)

test("a page a search found, given to page_view that cannot reach it, comes with the command that reads it", async () => {
  const { call } = start()
  await call("web_search", { query: "lanterna" })
  expect(await call("page_view", { page: "https://lanterna.example/blog/2-0" })).toBe(
    "The page could not be opened: not found A page that a web search found opens with `web_open`.",
  )
  expect(await call("page_view", { page: "https://altro.example/" })).toBe("The page could not be opened: not found")
})

test("a page the site does not have, on the site of the page that was open, brings that page back with its links", async () => {
  const hooks = { "page-not-found": "No page at {{url}}. Back on {{back}}:\n{{page}}" }
  const site = "http://127.0.0.1:5000"
  const page = (title: string, address: string, status: number): Page => ({
    title,
    items: [{ text: title }, { control: "link", label: "Services" }],
    errors: [],
    address,
    status,
  })
  // The pages the browser went through, the last one open; `view` asks the site, `back` does not.
  const history: Page[] = []
  const asked: string[] = []
  const went = (one: Page) => (history.push(one), one)
  const browser: Browser = {
    view: async (target) => {
      asked.push(target)
      if (target.includes("altro.example")) return went(page("Altrove", target, 404))
      return went(/:5000\/?$/.test(target) ? page("Town hall", `${site}/`, 200) : page("Not found", target, 404))
    },
    act: async () => went(page("Services", `${site}/services`, 200)),
    back: async () => (history.pop(), history.at(-1) ?? new Error("no page before")),
    close: async () => {},
  }
  const { call } = start({ hooks, browser })
  // The first page of all, not there: there is no page to go back to.
  expect(await call("page_view", { page: `${site}/nothing` })).toStartWith("Not found")
  await call("page_view", { page: site })
  await call("page_act", { action: "click", on: 1 })
  expect(await call("page_view", { page: `${site}/certificates` })).toBe(
    `No page at ${site}/certificates. Back on ${site}/services:\nServices\nServices\n[1] link: Services\n\nNo errors in the console`,
  )
  // The page is had again from the browser's history: the site is not asked for it a second time.
  expect(asked).toEqual([`${site}/nothing`, site, `${site}/certificates`])
  // Another site altogether: its page as it is.
  expect(await call("page_view", { page: "http://altro.example/x" })).toStartWith("Altrove")
  const off = start({ browser })
  await off.call("page_view", { page: site })
  expect(await off.call("page_view", { page: `${site}/certificates` })).toStartWith("Not found")
})

test("the user's own tools answer, and a web search before any of them is not made once, with the list of them", async () => {
  const hooks = { "web-before-own-tools": "Not searched. The user's own tools:\n{{tools}}" }
  const tools = [
    { name: "price_current", description: "The list price of an article", answers: "3.20 euro" },
    { name: "stock_on_hand", description: "The stock of an article", answers: "12 pieces" },
  ]
  const before = start({ hooks, tools })
  expect(await before.call("web_search", { query: "prezzo QR-105" })).toBe(
    "Not searched. The user's own tools:\n- `price_current`: The list price of an article\n- `stock_on_hand`: The stock of an article",
  )
  expect(await before.call("web_search", { query: "prezzo QR-105" })).toStartWith("1. Lanterna")
  const after = start({ hooks, tools })
  expect(await after.call("price_current", { code: "QR-105" })).toBe("3.20 euro")
  expect(await after.call("web_search", { query: "prezzo QR-105" })).toStartWith("1. Lanterna")
  expect(await start({ hooks }).call("web_search", { query: "lanterna" })).toStartWith("1. Lanterna")
})

test("a file made with a name the request does not give, while a file it names is still missing, is said", async () => {
  const hooks = { "file-named-otherwise": "You wrote `{{path}}`, but the request names {{named}}." }
  const { harness } = start({ hooks, files: { "lib/three.js": "x" } })
  harness.message(
    "Fammi oggetti.html con un cubo che ruota; la libreria è in lib/three.js. Poi il testo in «note di oggi.txt».",
  )
  const written = (file: string) => harness.call("write", { path: file, content: "x" })
  expect((await written("objects.html")).text).toEndWith(
    "<system-reminder>\nYou wrote `objects.html`, but the request names `oggetti.html`.\n</system-reminder>",
  )
  expect((await written("oggetti.html")).text).not.toContain("request names")
  expect((await written("note.txt")).text).toEndWith(
    "<system-reminder>\nYou wrote `note.txt`, but the request names `note di oggi.txt`.\n</system-reminder>",
  )
  // A file of another kind, or one the harness does not watch: nothing said.
  expect((await written("style.css")).text).not.toContain("request names")
  // The named files in a folder the user named are where they asked; in a folder of the model's own, they are not.
  const inFolder = start({ hooks })
  inFolder.harness.message("Nella nuova cartella «già fatti» mi servono «perché.txt» e «preventivo Rossi.txt».")
  const put = (file: string) => inFolder.harness.call("write", { path: file, content: "x" })
  expect((await put("già fatti/perché.txt")).text).not.toContain("request names")
  expect((await put("già fatti/preventivo Rossi.txt")).text).not.toContain("request names")
  const elsewhere = start({ hooks })
  elsewhere.harness.message("Nella nuova cartella «già fatti» mi serve «perché.txt».")
  expect((await elsewhere.harness.call("write", { path: "src/perché.txt", content: "x" })).text).toEndWith(
    "<system-reminder>\nYou wrote `src/perché.txt`, but the request names `perché.txt`.\n</system-reminder>",
  )
  const quiet = start({})
  quiet.harness.message("Fammi oggetti.html.")
  expect((await quiet.harness.call("write", { path: "objects.html", content: "x" })).text).not.toContain(
    "request names",
  )
})

test("a page written comes back with a line that says to look at it", async () => {
  const html = "<title>Greetings</title><h1>Hello</h1><script>boom()</script>"
  const shown =
    "Greetings\nHello\n[1] button: Colour\n[2] field: Name\n\nErrors of the console:\nUncaught ReferenceError: boom is not defined (page.html:3)"
  const one = start({ hooks: { "after-page-written": "`page_view` it before you say it is done." } })
  expect(await one.call("write", { path: "page.html", content: html })).toBe(
    "Written page.html (1 lines)\n\n<system-reminder>\n`page_view` it before you say it is done.\n</system-reminder>",
  )
  expect(await one.call("page_view", { page: "page.html" })).toBe(shown)
  expect(await one.call("page_view", { page: "other.html" })).toStartWith("No file other.html.")
})

test("an action on the page needs a page and a number that is on it", async () => {
  const { call, acted } = start({ files: { "page.html": "<title>Greetings</title>" } })
  expect(await call("page_act", { action: "click", on: 1 })).toBe("No page is open: `page_view` one first.")
  expect(await call("page_view", { page: "page.html" })).toBe(
    "Greetings\nHello\n[1] button: Colour\n[2] field: Name\n\nNo errors in the console",
  )
  expect(await call("page_act", { action: "click", on: 3 })).toBe(
    "There is no 3 on the page: the numbers go from 1 to 2.",
  )
  expect(await call("page_act", { action: "type", on: 2 })).toBe("`type` needs `text`: what to write.")
  expect(await call("page_act", { action: "type", on: "2", text: "Anna" })).toBe(
    "After\ndone type\n\nNo errors in the console",
  )
  expect(acted).toEqual(["type 2 Anna"])
})

test("a question goes to the user, and their answer comes back", async () => {
  const { call, asked } = start()
  expect(await call("ask", { question: "Which file?", options: ["the first", "the second"] })).toBe("the second")
  expect(asked).toEqual(["Which file? [the first|the second]"])
})

test("a command that is not there, a parameter that is missing, a number that is not one", async () => {
  const { call } = start()
  expect(await call("bash", { command: "ls" })).toStartWith(
    "No command named bash. The commands are: skill, terminal, read,",
  )
  expect(await call("write", { path: "a.txt" })).toBe("`write` needs `content`.")
  expect(await call("read", { path: "a.txt", from: "ten" })).toBe("`from` must be a whole number, 1 or more.")
})

// ---------------------------------------------------------------- what a model really sends

test("outside the project anything can be read, and nothing is written or run unless the user named the place", async () => {
  const { harness, call, project } = start({ files: { "notes.txt": "one\n" } })
  const outer = fs.mkdtempSync(path.join(ROOT, "outer-"))
  const other = fs.mkdtempSync(path.join(ROOT, "other-"))
  fs.writeFileSync(path.join(outer, "secret.txt"), "SECRET\n")
  fs.symlinkSync(outer, path.join(project, "link"), "junction")
  const up = `../${path.basename(outer)}`
  expect(await call("read", { path: path.join(outer, "secret.txt") })).toEndWith("\nSECRET")
  expect(await call("search", { text: "SECRET", folder: "link" })).toContain("SECRET")
  const refused = [
    await call("write", { path: "link/new.txt", content: "x" }),
    await call("write", { path: path.join(outer, "new.txt"), content: "x" }),
    await call("edit", { path: path.join(outer, "secret.txt"), old: "SECRET", new: "x" }),
    await call("terminal", { command: "Get-ChildItem", folder: "link" }),
    await call("terminal", { command: `python ${up}/run.py` }),
    await call("terminal", { command: "Get-ChildItem ~ | Out-String" }),
    await call("terminal", { command: "Copy-Item notes.txt $env:TEMP\\notes.txt" }),
  ]
  expect(refused.filter((answer) => !answer.includes("is outside the project"))).toEqual([])
  expect(await call("search", { name: `${up}/*` })).toStartWith("`name` is a pattern")
  expect([fs.existsSync(path.join(outer, "new.txt")), fs.readFileSync(path.join(outer, "secret.txt"), "utf8")]).toEqual(
    [false, "SECRET\n"],
  )

  harness.message(`Salva una copia delle note in ${outer}, grazie.`)
  expect(await call("write", { path: path.join(outer, "copia", "notes.txt"), content: "one\n" })).toBe(
    `Written ${path.join(outer, "copia", "notes.txt")} (1 lines)`,
  )
  expect((await call("write", { path: path.join(other, "notes.txt"), content: "one\n" })).includes("is outside")).toBe(
    true,
  )
  harness.message(`Guarda in ${path.dirname(project)}.`)
  expect((await call("write", { path: path.join(other, "notes.txt"), content: "one\n" })).includes("is outside")).toBe(
    true,
  )
})

test("an optional parameter given empty is as if it was not given, and one the command does not have is left out", async () => {
  const { call } = start({ files: { "a.txt": "one\ntwo\n" } })
  expect(await call("search", { name: "*.txt", text: null, folder: null })).toBe("a.txt")
  expect(await call("read", { path: "a.txt", from: null, lines: "" })).toBe("a.txt, lines 1-2 of 2\none\ntwo")
  expect(await call("edit", { path: "a.txt", old: null, new: "three" })).toBe(
    "`edit` needs `old`: the text that is in the file now.",
  )
  expect(await call("read", { path: "a.txt", lines: 0 })).toBe("`lines` must be a whole number, 1 or more.")
  expect(await call("read", { path: "a.txt", filePath: "b.txt", offset: 3 })).toStartWith("a.txt, lines 1-2 of 2")
  expect(await call("constructor", {})).toStartWith("No command named constructor.")
})

test("the terminal gives accents as they are and the exit code of the program that failed", async () => {
  const { harness, call } = start()
  expect(await call("terminal", { command: "Write-Output 'città è già più'" })).toBe("città è già più")
  expect(await harness.call("terminal", { command: "cmd /c exit 3" })).toEqual({
    text: "(the command failed and printed nothing)\n\nexit 3",
    failed: true,
  })
  expect(await call("terminal", { command: "Get-Item nothing-here.txt" })).toMatch(
    /^Get-Item: Cannot find path .*nothing-here\.txt. because it does not exist\.\n\nexit 1$/,
  )
})

test("a file that is not UTF-8 keeps its bytes when a piece of it is changed", async () => {
  const { call, project } = start()
  fs.writeFileSync(path.join(project, "names.csv"), Buffer.from("Mario;città\r\nLucia;perché\r\n", "latin1"))
  expect(await call("read", { path: "names.csv" })).toBe("names.csv, lines 1-2 of 2\nMario;città\nLucia;perché")
  await call("edit", { path: "names.csv", old: "Mario", new: "Maria" })
  expect(
    fs.readFileSync(path.join(project, "names.csv")).equals(Buffer.from("Maria;città\r\nLucia;perché\r\n", "latin1")),
  ).toBe(true)
})

test("a very long line is cut, an empty file can be replaced unread, an address may hold brackets", async () => {
  const { harness, call } = start({ files: { "long.txt": `${"x".repeat(5000)}\n`, "empty.txt": "" } })
  expect(await call("read", { path: "long.txt" })).toBe(
    `long.txt, lines 1-1 of 1\n${"x".repeat(1000)} … (4000 more characters)`,
  )
  expect(await call("write", { path: "empty.txt", content: "now\n" })).toBe("Written empty.txt (1 lines)")
  harness.message("Read https://lanterna.example/wiki/Lamp_(tool), please.")
  expect(await call("web_open", { url: "https://lanterna.example/wiki/Lamp_(tool)" })).toStartWith(
    "Lanterna 2.0 is out",
  )
})

test("a line of code that begins with # in the last step stays in the step", async () => {
  const { call } = start()
  await call("plan", {
    text: "# Goal\nA script.\n## Step 1: write it\nIn run.sh:\n```\n# install\nnpm ci\n```\nCheck: it runs.\n# Not doing\nNothing else.",
  })
  expect(await call("plan", { done: 1 })).toEndWith(
    "All steps done. Read the goal and Not doing once more, then answer the user",
  )
  expect(await call("plan", {})).toContain("```\n# install\nnpm ci\n```\nCheck: it runs.\n# Not doing")
})

// ---------------------------------------------------------------- sight

const PICTURE = { mime: "image/png", base64: "iVBORw0KGgo=" } as const
/** A browser whose page holds a canvas and which can take a picture; `looked` counts the pictures. */
const seeing = () => {
  const looked = { n: 0, opened: [] as string[] }
  const shown = (title: string): Page => ({ title, items: [{ text: title }], errors: [], unseen: true })
  const browser: Browser = {
    view: async (target) => (looked.opened.push(target), shown(path.basename(target))),
    act: async () => shown("After"),
    back: async () => new Error("no page before"),
    look: async () => (looked.n++, PICTURE),
    close: async () => {},
  }
  return { browser, looked }
}

test("page_look gives the picture of the open page, and says so in words", async () => {
  const { browser, looked } = seeing()
  const { harness, call } = start({ browser, vision: true, files: { "a.html": "<canvas>" } })
  await call("page_view", { page: "a.html" })
  expect(await harness.call("page_look", {})).toEqual({
    text: "The picture of the page follows.",
    failed: false,
    images: [PICTURE],
  })
  expect(looked.n).toBe(1)
})

test("page_look with a page opens it first, as page_view does, and refuses what page_view refuses", async () => {
  const { browser, looked } = seeing()
  const { harness, project } = start({ browser, vision: true, files: { "a.html": "<canvas>" } })
  expect((await harness.call("page_look", { page: "a.html" })).images).toEqual([PICTURE])
  expect(looked.opened).toEqual([path.join(project, "a.html")])
  const missing = await harness.call("page_look", { page: "none.html" })
  expect([missing.failed, missing.images]).toEqual([true, undefined])
  expect(missing.text).toContain("none.html")
  expect((await harness.call("page_look", { page: "C:\\*" })).failed).toBe(true)
  expect(looked.n).toBe(1)
})

test("page_look with no page open says to open one, and a browser that cannot take a picture says so", async () => {
  const { browser } = seeing()
  const { harness } = start({ browser, vision: true })
  expect(await harness.call("page_look", {})).toEqual({
    text: "No page is open: give `page`, or `page_view` one first.",
    failed: true,
  })
  const blind = start({ vision: true, files: { "a.html": "<p>x</p>" } })
  await blind.call("page_view", { page: "a.html" })
  expect(await blind.harness.call("page_look", {})).toEqual({
    text: "The page could not be photographed: this browser takes no pictures.",
    failed: true,
  })
})

test("without sight there is no page_look, and page_view does not mention it", async () => {
  const { browser } = seeing()
  const { harness, call } = start({ browser, files: { "a.html": "<canvas>" } })
  expect(await call("page_look", {})).toStartWith("No command named page_look.")
  expect(await call("page_view", { page: "a.html" })).not.toContain("page_look")
  expect((await harness.call("page_view", { page: "a.html" })).images).toBeUndefined()
})

test("page_view and page_act end with one line that names page_look when the page holds what text cannot carry", async () => {
  const { browser } = seeing()
  const { call } = start({ browser, vision: true, files: { "a.html": "<canvas>" } })
  expect(await call("page_view", { page: "a.html" })).toEndWith(`No errors in the console\n\n${LOOK_HINT}`)
  expect(LOOK_HINT.includes("\n")).toBe(false)
  expect(await call("page_act", { action: "press", text: "Enter" })).toEndWith(LOOK_HINT)
  // A page with nothing more than its text gets no line.
  const plain = start({ vision: true, files: { "b.html": "<p>text</p>" } })
  expect(await plain.call("page_view", { page: "b.html" })).not.toContain("page_look")
})
