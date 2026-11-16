import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Archive } from "@/util/archive"
import { systemTar } from "@opencode-ai/core/util/system-tar"
import { tmpdir } from "../fixture/fixture"

const zipOf = async (root: string, name: string, file: string, content: string) => {
  await fs.mkdir(path.join(root, "src", "nested"), { recursive: true })
  await fs.writeFile(path.join(root, "src", "nested", file), content)
  const zip = path.join(root, name)
  Bun.spawnSync([systemTar(), "-a", "-cf", zip, "-C", path.join(root, "src"), "nested"])
  return zip
}

describe("archive", () => {
  test.skipIf(process.platform !== "win32")("extractZip creates the destination and unpacks nested files", async () => {
    await using tmp = await tmpdir()
    const zip = await zipOf(tmp.path, "a.zip", "a.txt", "content")

    await Archive.extractZip(zip, path.join(tmp.path, "out", "deep"))

    expect(await fs.readFile(path.join(tmp.path, "out", "deep", "nested", "a.txt"), "utf8")).toBe("content")
  })

  test.skipIf(process.platform !== "win32")("extractZip reads paths with spaces and non-ASCII characters", async () => {
    await using tmp = await tmpdir()
    const folder = path.join(tmp.path, "folder with spaces", "naïve é ü")
    await fs.mkdir(folder, { recursive: true })
    const zip = await zipOf(folder, "archive é.zip", "café.txt", "espresso")

    await Archive.extractZip(zip, path.join(folder, "destination ñ", "ü"))

    expect(await fs.readFile(path.join(folder, "destination ñ", "ü", "nested", "café.txt"), "utf8")).toBe(
      "espresso",
    )
  })

  test.skipIf(process.platform !== "win32")("extractZip fails on a damaged archive", async () => {
    await using tmp = await tmpdir()
    const zip = path.join(tmp.path, "broken.zip")
    await fs.writeFile(zip, "this is not a zip file")

    await expect(Archive.extractZip(zip, path.join(tmp.path, "out"))).rejects.toThrow()
  })

  test.skipIf(process.platform !== "win32")("extractZip says so when the system folder is unknown", async () => {
    await using tmp = await tmpdir()
    const saved = process.env.SystemRoot
    delete process.env.SystemRoot
    try {
      await expect(Archive.extractZip(path.join(tmp.path, "a.zip"), path.join(tmp.path, "out"))).rejects.toThrow(
        "SystemRoot is not set",
      )
    } finally {
      process.env.SystemRoot = saved
    }
  })
})
