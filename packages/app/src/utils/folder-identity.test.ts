import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const roots = [path.resolve(import.meta.dir, ".."), path.resolve(import.meta.dir, "../../../session-ui/src")]

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return sources(file)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : []
  })

const lines = roots.flatMap((root) =>
  sources(root).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((text, index) => ({ where: `${path.relative(roots[0]!, file)}:${index + 1}`, text })),
  ),
)

// A comparison whose operand is wrapped in `folderKey(...)` or only asks for a type is not one of the raw ones.
const plain = (text: string) =>
  text.replace(/folderKey\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "KEY").replace(/typeof [\w.]+/g, "TYPE")

const found = (pattern: RegExp, allowed: string[] = []) =>
  lines
    .filter((line) => pattern.test(plain(line.text)) && !allowed.some((item) => line.text.includes(item)))
    .map((line) => `${line.where}: ${line.text.trim()}`)

// Two paths are the same folder when `folderKey` says so: a Windows path can be written in more than one way. `pathKey`
// keeps the spelling, for what is stored under it or passed to the server as a path, and is never compared.
describe("the identity of a project folder", () => {
  test("is never decided by comparing paths as they were written", () => {
    expect(found(/pathKey\([^()]*(?:\([^()]*\)[^()]*)*\)\s*[!=]==/)).toEqual([])
    expect(found(/[!=]==\s*pathKey\(/)).toEqual([])
  })

  test("is never decided by comparing the directory of a session or of the page as it was written", () => {
    const operand = String.raw`[\w.?!()]*\.directory\b`
    const raw = new RegExp(String.raw`${operand}\s*[!=]==\s+(?!\s)(?!undefined|["'])|[!=]==\s*${operand}`)
    expect(
      found(raw, [
        // what is stored of a tab is written again only when it changed
        "current.directory === next.directory",
        // events of the same instance, as the server names it, are put together
        "previous.directory === event.directory",
        "previous.directory !== event.directory",
        // the directory the request was made for, read back from the same place
        "sdk().directory !== dir",
        // the route that was synced is synced again when its address changed, and the storage key of a folder is set beside its own spelling
        "dir !== activeRoute.directory",
        "key !== created.directory",
      ]),
    ).toEqual([])
  })

  test("is never decided by comparing a project's worktree as it was written", () => {
    const operand = String.raw`[\w.?!]*\.worktree\b`
    const raw = new RegExp(String.raw`${operand}\s*[!=]==\s+(?!\s)(?!undefined|["'])|[!=]==\s*${operand}`)
    expect(
      found(raw, [
        // the ids of a project in the list, which are the list's own entries: hover, peek, the project being dragged
        "project.worktree === id",
        "p.worktree === props.activeProject()",
        "project.worktree === active)",
        "p.worktree === draggable.id.toString()",
        "p.worktree === droppable.id.toString()",
        // the row of a list is looked up in the same list
        "item.worktree === props.worktree",
      ]),
    ).toEqual([])
  })
})
