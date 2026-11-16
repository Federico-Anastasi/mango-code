import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { systemTar } from "@opencode-ai/core/util/system-tar"
import { testEffect } from "../lib/effect"

const exe = process.platform === "win32" ? "rg.exe" : "rg"
const target = path.join(Global.Path.bin, exe)
const saved = { PATH: process.env.PATH, PSModulePath: process.env.PSModulePath }

// The module path that PowerShell 7 exports to its children: Windows PowerShell 5.1 reads it as its own and loads the
// archive module of 7.x, which fails without a non-zero exit code.
const POWERSHELL_7_MODULES = [
  "C:\\Program Files\\PowerShell\\Modules",
  "c:\\program files\\windowsapps\\microsoft.powershell_7.7.0.0_x64__8wekyb3d8bbwe\\Modules",
  "C:\\Program Files\\WindowsPowerShell\\Modules",
  "C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
].join(path.delimiter)

const requested: string[] = []

const archive = async (filename: string) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "rg-archive-"))
  try {
    const root = filename.replace(/\.(zip|tar\.gz)$/, "")
    await fs.mkdir(path.join(work, "src", root), { recursive: true })
    await fs.writeFile(path.join(work, "src", root, exe), "fake ripgrep")
    const out = path.join(work, filename)
    Bun.spawnSync([
      systemTar(),
      ...(filename.endsWith(".zip") ? ["-a", "-cf"] : ["-czf"]),
      out,
      "-C",
      path.join(work, "src"),
      root,
    ])
    return Uint8Array.from(await fs.readFile(out))
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

const served = (bytes: (filename: string) => Promise<Uint8Array<ArrayBuffer>>) =>
  testEffect(
    LayerNode.compile(RipgrepBinary.node, [
      [
        httpClient,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((req) =>
            Effect.promise(async () => {
              requested.push(req.url)
              return HttpClientResponse.fromWeb(req, new Response(await bytes(req.url.split("/").pop()!)))
            }),
          ),
        ),
      ],
    ]),
  )

const withoutSystemRipgrep = () => {
  process.env.PSModulePath = POWERSHELL_7_MODULES
  process.env.PATH = (saved.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => !Bun.which("rg", { PATH: dir }))
    .join(path.delimiter)
  requested.length = 0
  return Effect.promise(() => fs.rm(target, { force: true }))
}

afterEach(async () => {
  process.env.PATH = saved.PATH
  if (saved.PSModulePath === undefined) delete process.env.PSModulePath
  else process.env.PSModulePath = saved.PSModulePath
  await fs.rm(target, { force: true })
})

describe("RipgrepBinary", () => {
  served(archive).live("unpacks the downloaded archive from a terminal that carries the PowerShell 7 module path", () =>
    Effect.gen(function* () {
      yield* withoutSystemRipgrep()

      const file = yield* (yield* RipgrepBinary.Service).filepath

      expect(file).toBe(target)
      expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("fake ripgrep")
      expect(requested).toHaveLength(1)
      expect(requested[0]).toEndWith(process.platform === "win32" ? ".zip" : ".tar.gz")
    }),
  )

  served(async () => new TextEncoder().encode("not an archive")).live(
    "reports a downloaded archive that cannot be unpacked instead of going on without ripgrep",
    () =>
      Effect.gen(function* () {
        yield* withoutSystemRipgrep()

        const exit = yield* Effect.exit((yield* RipgrepBinary.Service).filepath)

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Effect.promise(() => fs.stat(target).catch(() => undefined))).toBeUndefined()
      }),
  )
})
