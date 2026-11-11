import { describe, expect, test } from "bun:test"
import { defaultProjectDirectory } from "./default-project"

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
