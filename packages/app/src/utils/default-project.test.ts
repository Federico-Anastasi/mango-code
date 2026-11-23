import { describe, expect, test } from "bun:test"
import { defaultProjectDirectory, defaultProjectFolders, projectLabel } from "./default-project"

const root = "C:\\Users\\a\\Documents\\Mango Code"

describe("the folder of the conversations without a project", () => {
  test("the first time it is made inside the projects folder", async () => {
    const made: string[] = []
    const platform = {
      projectsFolder: async () => root,
      createProjectFolder: async (name: string) => (made.push(name), `${root}\\${name}`),
    }
    expect(await defaultProjectDirectory(platform, "Conversazioni")).toBe(`${root}\\Conversazioni`)
    expect(made).toEqual(["Conversazioni"])
  })

  test("after that it is the same folder, not another one and not an error", async () => {
    const platform = {
      projectsFolder: async () => root,
      createProjectFolder: async () => {
        throw { code: "exists", message: `${root}\\Conversazioni` }
      },
    }
    expect(await defaultProjectDirectory(platform, "Conversazioni")).toBe(`${root}\\Conversazioni`)
  })

  test("any other failure is reported, not hidden", async () => {
    const platform = {
      projectsFolder: async () => root,
      createProjectFolder: async () => {
        throw { code: "io", message: "accesso negato" }
      },
    }
    await expect(defaultProjectDirectory(platform, "Conversazioni")).rejects.toMatchObject({ code: "io" })
  })
})

describe("which conversations belong to no project", () => {
  const names = ["Conversazioni", "Conversations"]
  const folders = defaultProjectFolders(root, names)

  test("the default folder is one in the projects folder, whichever language its name was made in", () => {
    expect(projectLabel({ directory: `${root}\\Conversazioni`, folders })).toBeUndefined()
    expect(projectLabel({ directory: `${root}\\Conversations`, folders })).toBeUndefined()
  })

  test("a folder of that name anywhere else is a project like the others", () => {
    expect(projectLabel({ directory: "D:\\work\\Conversazioni", folders })).toBe("Conversazioni")
  })

  test("a project is named as its list names it, and a folder with none by its own name", () => {
    const project = { name: "Fatture", worktree: "D:\\work\\invoice-tool" }
    expect(projectLabel({ directory: project.worktree, project, folders })).toBe("Fatture")
    expect(projectLabel({ directory: "D:\\work\\invoice-tool", folders })).toBe("invoice-tool")
  })

  test("before the projects folder is known no conversation is taken for one without a project", () => {
    const unknown = defaultProjectFolders(undefined, names)
    expect(projectLabel({ directory: `${root}\\Conversazioni`, folders: unknown })).toBe("Conversazioni")
  })
})
