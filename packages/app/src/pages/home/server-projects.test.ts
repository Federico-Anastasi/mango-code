import { describe, expect, test } from "bun:test"
import { projectsToOpen } from "./server-projects"

const project = (worktree: string, updated: number) => ({ worktree, time: { created: 1, updated } })

describe("projectsToOpen", () => {
  test("the projects the agent knows and this browser does not, oldest first (the last one opened is on top)", () => {
    const known = [project("C:/a", 30), project("C:/b", 10), project("C:/c", 20)]
    expect(projectsToOpen(known, ["C:/b"], [])).toEqual(["C:/c", "C:/a"])
  })

  test("what the user closed on this browser does not come back", () => {
    expect(projectsToOpen([project("C:/a", 2), project("C:/b", 1)], [], ["C:/a"])).toEqual(["C:/b"])
  })

  test("paths are compared like the rest of the app (backslashes and a final slash on Windows)", () => {
    expect(projectsToOpen([project(String.raw`C:\Users\Me\App`, 1)], ["C:/Users/Me/App/"], [])).toEqual([])
  })

  test("the global pseudo-project is not a folder to show", () => {
    expect(projectsToOpen([project("/", 5), project("C:/a", 1)], [], [])).toEqual(["C:/a"])
  })
})
