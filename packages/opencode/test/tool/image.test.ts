import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Exit, Fiber } from "effect"
import path from "path"
import fs from "fs/promises"
import { fileName, ImageTool, pictureOutput } from "../../src/tool/image"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// mango-code: the `image_generate` tool against a control server that is not the app's: it remembers what it was asked and
// answers a job that draws for a few requests and then ends as the test says.
const original = process.env.MANGO_CONTROL_URL
const originalLanguage = process.env.MANGO_SYSTEM_LANGUAGE
// The smallest PNG there is: the picture every job of the fake server makes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

beforeAll(() => {
  process.env.MANGO_SYSTEM_LANGUAGE = "en"
})

afterAll(() => {
  if (originalLanguage === undefined) delete process.env.MANGO_SYSTEM_LANGUAGE
  else process.env.MANGO_SYSTEM_LANGUAGE = originalLanguage
})

afterEach(async () => {
  if (original === undefined) delete process.env.MANGO_CONTROL_URL
  else process.env.MANGO_CONTROL_URL = original
  await disposeAllInstances()
})

// `ending` is how the job ends; `broken` answers 500 to the job once it was drawing, `silent` never answers the
// requests named in `mute`. `wrote` is the file the app says it wrote (the one it took when the name was taken).
function control(
  ending: "done" | "failed" | "never" | "broken" = "done",
  options: { mute?: string[]; wrote?: string; models?: boolean } = {},
) {
  const seen: { method: string; path: string; body: any }[] = []
  let asked = 0
  const job = (status: string, step: number) => ({
    id: "image-1",
    status,
    model: "z-image-turbo",
    prompt: "",
    width: 768,
    height: 768,
    seed: status === "done" ? 42 : null,
    step,
    steps: 8,
    seconds: 1,
    error: status === "failed" ? "Not enough memory on the card." : null,
    detail: status === "failed" ? "CUDA out of memory" : null,
    file: status === "done" ? (options.wrote ?? null) : null,
    preview: null,
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const text = await request.text()
      seen.push({ method: request.method, path: pathname, body: text ? JSON.parse(text) : undefined })
      if (options.mute?.includes(pathname)) return new Promise<Response>(() => {})
      if (pathname === "/control/image") return Response.json({ models: [{ key: "z-image-turbo", ready: options.models ?? true }] })
      if (pathname === "/control/image/generate") return Response.json(job("waiting", 0), { status: 202 })
      if (pathname === "/control/image/jobs/image-1/picture") return Response.json({ png: PNG })
      if (pathname === "/control/image/jobs/image-1/cancel") return Response.json(job("cancelled", 0))
      asked++
      if (asked >= 3 && ending === "broken") return Response.json({ error: { message: "The app broke." } }, { status: 500 })
      if (asked < 3 || ending === "never" || ending === "broken") return Response.json(job("drawing", asked))
      return Response.json(job(ending, 8))
    },
  })
  process.env.MANGO_CONTROL_URL = `http://127.0.0.1:${server.port}`
  return { server, seen }
}

function context(over: Partial<Tool.Context> = {}) {
  const asks: unknown[] = []
  const titles: string[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_test-image-session"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: (input) => Effect.sync(() => void (input.title && titles.push(input.title))),
    ask: (input) => Effect.sync(() => void asks.push(input)),
    ...over,
  }
  return { ctx, asks, titles }
}

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, Truncate.node, Agent.node])))

const run = Effect.fn("ImageToolTest.run")(function* (args: Tool.InferParameters<typeof ImageTool>, ctx: Tool.Context) {
  const info = yield* ImageTool
  const tool = yield* info.init()
  return yield* tool.execute(args, ctx)
})

describe("tool.image_generate", () => {
  it.instance("asks the user, asks the app for the picture in the project's folder, and gives it back", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fake = control()
      const { ctx, asks, titles } = context()
      const result = yield* run({ prompt: "a red cat on a sofa", name: "Red Cat!.png", format: "portrait" }, ctx).pipe(
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(asks).toHaveLength(1)
      expect(asks[0]).toMatchObject({ permission: "image", metadata: { prompt: "a red cat on a sofa", width: 576, height: 1024 } })
      const sent = fake.seen.find((r) => r.path === "/control/image/generate")!.body
      expect(sent).toMatchObject({ prompt: "a red cat on a sofa", width: 576, height: 1024 })
      expect(path.dirname(path.dirname(sent.file))).toBe(test.directory)
      expect(path.basename(sent.file)).toBe("red-cat.png")
      expect(result.output).toContain("red-cat.png (576x1024)")
      expect(result.metadata).toMatchObject({ file: sent.file, seed: 42, model: "z-image-turbo" })
      expect(result.attachments).toEqual([{ type: "file", mime: "image/png", filename: "red-cat.png", url: `data:image/png;base64,${PNG}` }])
      expect(titles.some((title) => title.endsWith("(2/8)"))).toBe(true)
    }),
  )

  it.instance("does not ask again in a conversation that already has a picture", () =>
    Effect.gen(function* () {
      const fake = control()
      const earlier = { parts: [{ type: "tool", tool: "image_generate", state: { status: "completed" } }] }
      const { ctx, asks } = context({ messages: [earlier] as unknown as Tool.Context["messages"] })
      yield* run({ prompt: "a dog", name: "dog", size: "large" }, ctx).pipe(Effect.ensuring(Effect.sync(() => fake.server.stop(true))))

      expect(asks).toHaveLength(0)
      expect(fake.seen.find((r) => r.path === "/control/image/generate")!.body).toMatchObject({ width: 1024, height: 1024 })
    }),
  )

  it.instance("a picture never replaces one that is there", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const fake = control()
      const first = yield* run({ prompt: "a dog", name: "dog" }, context().ctx)
      const folder = path.dirname(first.metadata.file as string)
      yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }).then(() => fs.writeFile(first.metadata.file as string, "")))
      const second = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(path.dirname(folder)).toBe(test.directory)
      expect(path.basename(second.metadata.file as string)).toBe("dog-2.png")
    }),
  )

  it.instance("with no model that draws on the computer the model is told what to tell the user, and nothing is asked", () =>
    Effect.gen(function* () {
      const { server, seen } = control("done", { models: false })
      const marks: unknown[] = []
      const { ctx, asks } = context({ metadata: (input) => Effect.sync(() => void marks.push(input.metadata)) })
      const exit = yield* run({ prompt: "a cat", name: "cat" }, ctx).pipe(Effect.exit)
      server.stop(true)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("no model that draws is on this computer yet")
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("«Download a model» button")
      expect(asks).toEqual([])
      expect(marks).toEqual([{ missing: true }])
      expect(seen.map((request) => request.path)).toEqual(["/control/image"])
    }),
  )

  it.instance("a picture that fails tells the model why", () =>
    Effect.gen(function* () {
      const fake = control("failed")
      const exit = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("Not enough memory on the card. CUDA out of memory")
    }),
  )

  it.instance("a turn that is stopped stops the picture", () =>
    Effect.gen(function* () {
      const fake = control("never")
      const stop = new AbortController()
      setTimeout(() => stop.abort(), 1000)
      const exit = yield* run({ prompt: "a dog", name: "dog" }, context({ abort: stop.signal }).ctx).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(fake.seen.some((r) => r.method === "POST" && r.path === "/control/image/jobs/image-1/cancel")).toBe(true)
    }),
  )

  it.instance("a picture whose job cannot be followed any more is stopped in the app", () =>
    Effect.gen(function* () {
      const fake = control("broken")
      const exit = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(String(exit)).toContain("The app broke.")
      expect(fake.seen.filter((r) => r.method === "POST" && r.path === "/control/image/jobs/image-1/cancel")).toHaveLength(1)
    }),
  )

  it.instance("a job that ended by itself is not cancelled", () =>
    Effect.gen(function* () {
      const fake = control("failed")
      yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
        Effect.exit,
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(fake.seen.some((r) => r.path.endsWith("/cancel"))).toBe(false)
    }),
  )

  it.instance("the file of the picture is the one the app says it wrote", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const wrote = path.join(test.directory, "images", "dog-2.png")
      const fake = control("done", { wrote })
      const result = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
        Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
      )

      expect(fake.seen.find((r) => r.path === "/control/image/generate")!.body.file).toBe(path.join(test.directory, "images", "dog.png"))
      expect(result.title).toBe(path.join("images", "dog-2.png"))
      expect(result.output).toContain("dog-2.png")
      expect(result.metadata).toMatchObject({ file: wrote })
      expect(result.attachments).toMatchObject([{ filename: "dog-2.png" }])
    }),
  )

  it.instance(
    "an app that takes the request and never answers ends the call with the sentence of the missing app",
    () =>
      Effect.gen(function* () {
        const fake = control("done", { mute: ["/control/image/generate"] })
        const exit = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
          Effect.exit,
          Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
        )

        expect(String(exit)).toContain("The Mango Code app is not answering")
      }),
    20_000,
  )

  it.instance(
    "a stop that cannot be delivered to the app still ends the turn",
    () =>
      Effect.gen(function* () {
        const fake = control("never", { mute: ["/control/image/jobs/image-1/cancel"] })
        const turn = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(
          Effect.ensuring(Effect.sync(() => fake.server.stop(true))),
          Effect.forkChild,
        )
        yield* Effect.promise(async () => {
          while (!fake.seen.some((r) => r.path === "/control/image/jobs/image-1")) await Bun.sleep(20)
        })

        const began = Date.now()
        yield* Fiber.interrupt(turn)

        expect(Date.now() - began).toBeLessThan(8000)
        expect(fake.seen.some((r) => r.path === "/control/image/jobs/image-1/cancel")).toBe(true)
      }),
    20_000,
  )

  it.instance("without the app the model is told that pictures are made by it", () =>
    Effect.gen(function* () {
      const fake = control()
      fake.server.stop(true)
      const exit = yield* run({ prompt: "a dog", name: "dog" }, context().ctx).pipe(Effect.exit)

      expect(String(exit)).toContain("The Mango Code app is not answering")
    }),
  )
})

describe("tool.image_generate: names and results", () => {
  test("a name Windows keeps for itself gets a word that makes it usable", () => {
    for (const name of ["nul", "con", "aux", "prn", "com1", "com9", "lpt1", "lpt9", "NUL", "con.png"])
      expect(fileName(name)).toMatch(/^(nul|con|aux|prn|com[1-9]|lpt[1-9])-picture$/i)
    for (const name of ["null", "console", "com10", "a nul", "lpt0"]) expect(fileName(name)).not.toMatch(/-picture$/)
    expect(fileName("a nul")).toBe("a-nul")
  })

  test("accented letters keep their letter in the name", () => {
    expect(fileName("Caffè e città, più tè")).toBe("caffe-e-citta-piu-te")
  })

  test("only the result for the model that asked for the picture asks it to look at it", () => {
    expect(pictureOutput("images/a.png", 768, 768)).toBe("Picture saved as images/a.png (768x768).")
    expect(pictureOutput("images/a.png", 768, 768, true)).toContain("Look at it")
  })
})
