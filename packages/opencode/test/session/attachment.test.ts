import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ATTACHMENT_DIR, safeName, saveAttachment } from "../../src/session/attachment"

const dirs: string[] = []
const project = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-test-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("safeName", () => {
  test("strips the path and the characters Windows does not allow", () => {
    expect(safeName("C:\\Users\\a\\photo.png")).toBe("photo.png")
    expect(safeName("../../etc/passwd")).toBe("passwd")
    expect(safeName('a<b>:"c|d?.txt')).toBe("a_b___c_d_.txt")
    expect(safeName("end. ")).toBe("end")
  })

  test("a name Windows reserves for a device (with or without extension) is not used as it is", () => {
    for (const name of ["nul", "CON.txt", "aux.tar.gz", "Com1.pdf", "lpt9"]) expect(safeName(name)).toBe(`_${name}`)
    // only the whole first part is reserved
    expect(safeName("console.log")).toBe("console.log")
    expect(safeName("nullable.txt")).toBe("nullable.txt")
  })

  test("without a usable name it gives one", () => {
    expect(safeName(undefined)).toBe("attachment")
    expect(safeName("...")).toBe("attachment")
  })
})

describe("saveAttachment", () => {
  test("saves in Attachments inside the project", async () => {
    const dir = await project()
    const saved = await saveAttachment(dir, "report.docx", Buffer.from("one"))
    expect(saved).toBe(path.join(dir, ATTACHMENT_DIR, "report.docx"))
    expect((await fs.readFile(saved)).toString()).toBe("one")
  })

  test("same name and same content: the file is reused", async () => {
    const dir = await project()
    const first = await saveAttachment(dir, "a.png", Buffer.from("x"))
    expect(await saveAttachment(dir, "a.png", Buffer.from("x"))).toBe(first)
    expect(await fs.readdir(path.join(dir, ATTACHMENT_DIR))).toEqual(["a.png"])
  })

  test("same name and different content: not overwritten, numbered", async () => {
    const dir = await project()
    const first = await saveAttachment(dir, "a.png", Buffer.from("one"))
    const second = await saveAttachment(dir, "a.png", Buffer.from("two"))
    const third = await saveAttachment(dir, "a.png", Buffer.from("three"))
    expect(path.basename(second)).toBe("a (2).png")
    expect(path.basename(third)).toBe("a (3).png")
    expect((await fs.readFile(first)).toString()).toBe("one")
    expect((await fs.readFile(second)).toString()).toBe("two")
  })

  test("a name with a path does not leave the folder", async () => {
    const dir = await project()
    const saved = await saveAttachment(dir, "../../outside.txt", Buffer.from("x"))
    expect(saved).toBe(path.join(dir, ATTACHMENT_DIR, "outside.txt"))
  })
})
