import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import path from "node:path"
import fs from "fs/promises"
import { clean, tmpdir } from "./fixture"

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("tries again when the system says the folder is not empty yet, and fails when it never is", async () => {
    const notEmpty = () => Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" })
    let calls = 0
    await clean("never-made", 5, async () => {
      if (++calls <= 2) throw notEmpty()
    })
    expect(calls).toBe(3)

    let stuck = 0
    await expect(
      clean("never-made", 3, async () => {
        stuck++
        throw notEmpty()
      }),
    ).rejects.toMatchObject({ code: "ENOTEMPTY" })
    expect(stuck).toBe(3)
  }, 30_000)

  test.skipIf(process.platform !== "win32")("waits for another process to let go of a file in the folder", async () => {
    const tmp = await tmpdir()
    const file = path.join(tmp.path, "held.txt")
    await fs.writeFile(file, "x")
    // Opened for reading and sharing only reading: Windows will not delete it, or the folder, until the process lets go.
    const holder = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); Write-Output 'held'; Start-Sleep -Seconds 60`],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    )
    try {
      await new Promise<void>((resolve) => holder.stdout.on("data", (data) => String(data).includes("held") && resolve()))
      await expect(fs.rm(tmp.path, { recursive: true })).rejects.toMatchObject({ code: "EBUSY" })
      setTimeout(() => holder.kill(), 800)
      await tmp[Symbol.asyncDispose]()
      expect(await fs.stat(tmp.path).then(() => true, () => false)).toBe(false)
    } finally {
      holder.kill()
    }
  }, 30_000)
})
