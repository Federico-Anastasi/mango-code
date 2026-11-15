import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Fiber } from "effect"
import path from "path"
import { Question } from "../../src/question"
import { Session } from "../../src/session/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ImageTurn } from "../../src/session/image-turn"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// mango-code: a picture that the user asks for in the interface is a turn of the session. Here the app's control
// server is a fake one that draws for a few requests and then ends as the test says, and the model that rewrites is a
// fake engine that answers what the test says and remembers what it was sent.
const originalControl = process.env.MANGO_CONTROL_URL
const originalLanguage = process.env.MANGO_SYSTEM_LANGUAGE
// The smallest PNG there is: the picture every job of the fake server makes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

beforeAll(() => {
  process.env.MANGO_SYSTEM_LANGUAGE = "en"
})

afterAll(() => {
  engine.server.stop(true)
  if (originalLanguage === undefined) delete process.env.MANGO_SYSTEM_LANGUAGE
  else process.env.MANGO_SYSTEM_LANGUAGE = originalLanguage
})

afterEach(async () => {
  if (originalControl === undefined) delete process.env.MANGO_CONTROL_URL
  else process.env.MANGO_CONTROL_URL = originalControl
  await disposeAllInstances()
})

function control(ending: "done" | "failed" | "never" = "done", wrote: string | null = null) {
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
    file: status === "done" ? wrote : null,
    preview: status === "drawing" ? PNG : null,
  })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const text = await request.text()
      seen.push({ method: request.method, path: pathname, body: text ? JSON.parse(text) : undefined })
      if (pathname === "/control/image/generate") return Response.json(job("waiting", 0), { status: 202 })
      if (pathname === "/control/image/jobs/image-1/picture") return Response.json({ png: PNG })
      if (pathname === "/control/image/jobs/image-1/cancel") return Response.json(job("cancelled", 0))
      asked++
      if (asked < 3 || ending === "never") return Response.json(job("drawing", asked))
      return Response.json(job(ending, 8))
    },
  })
  process.env.MANGO_CONTROL_URL = `http://127.0.0.1:${server.port}`
  return {
    seen,
    generated: () => seen.find((request) => request.path === "/control/image/generate")?.body,
    stop: Effect.sync(() => server.stop(true)),
  }
}

// The model that rewrites: it says the replies of the test one after the other (the last again and again), and every
// request it gets is kept.
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const engine = (() => {
  const state = { replies: [] as string[], seen: [] as any[] }
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      state.seen.push(await request.json())
      const reply = state.replies[Math.min(state.seen.length, state.replies.length) - 1] ?? ""
      return new Response(chunk({ role: "assistant", content: reply }) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  return {
    server,
    url: `http://127.0.0.1:${server.port}/v1`,
    say: (...replies: string[]) => {
      state.replies = replies
      state.seen = []
    },
    get seen() {
      return state.seen
    },
  }
})()

const model = { tool_call: true, attachment: false, temperature: true, limit: { context: 32768, output: 4096 } }
const config = {
  enabled_providers: ["mango"],
  model: "mango/local",
  provider: {
    mango: {
      name: "mango-code",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "dummy", baseURL: engine.url },
      models: { local: { name: "local", ...model } },
    },
  },
}

// The same agent with a model that reads images, and one with no provider at all: nothing there writes.
const seeing = {
  ...config,
  provider: {
    mango: {
      ...config.provider.mango,
      models: {
        local: { name: "local", ...model, attachment: true, modalities: { input: ["text", "image"] as ("text" | "image")[], output: ["text"] as ("text" | "image")[] } },
      },
    },
  },
}
const nothing = { enabled_providers: ["no-such-provider"] }

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionPrompt.node,
      Session.node,
      SessionProjector.node,
      Question.node,
      SessionRunState.node,
      SessionStatus.node,
    ]),
  ),
)

const boot = Effect.fn("ImageTurnTest.boot")(function* () {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({})
  return { prompt, sessions, chat }
})

const messages = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.messages({ sessionID })
  })

function toolPart(parts: SessionV1.Part[]) {
  const part = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
  expect(part?.tool).toBe("image_generate")
  return part!
}

/** The picture's tool part as the session holds it now. */
const picturePart = (sessionID: SessionID) =>
  messages(sessionID).pipe(
    Effect.map((all) => all.flatMap((message) => message.parts).find((part) => part.type === "tool")),
  )

const assertFree = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    expect(Exit.isSuccess(yield* run.assertNotBusy(sessionID).pipe(Effect.exit))).toBe(true)
    expect((yield* (yield* SessionStatus.Service).get(sessionID)).type).toBe("idle")
  })

/** Waits for the question the turn asks, and answers it. */
const answer = (...selected: string[]) =>
  Effect.gen(function* () {
    const question = yield* Question.Service
    const asked = yield* pollWithTimeout(
      question.list().pipe(Effect.map((all) => (all.length ? all[0] : undefined))),
      "the turn never asked a question",
    )
    yield* question.reply({ requestID: asked.id, answers: [selected] })
    return asked
  })

describe("session.image: a picture as a turn", () => {
  it.instance(
    "without rewriting it leaves the words, then the picture in the folder of the session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fake = control()
        const { prompt, chat } = yield* boot()
        yield* prompt
          .image({
            sessionID: chat.id,
            request: "un gatto rosso sul divano",
            rewrite: false,
            format: "portrait",
            seed: 7,
            model: "z-image-turbo",
          })
          .pipe(Effect.ensuring(fake.stop))

        const [asked, answered] = yield* messages(chat.id)
        expect(asked.info.role).toBe("user")
        expect(asked.parts).toHaveLength(1)
        expect(asked.parts[0]).toMatchObject({ type: "text", text: "un gatto rosso sul divano" })
        expect(asked.parts[0]).not.toHaveProperty("synthetic")
        expect(answered.info).toMatchObject({ role: "assistant", parentID: asked.info.id })
        expect(answered.parts).toHaveLength(1)

        const sent = fake.generated()
        expect(sent).toMatchObject({
          prompt: "un gatto rosso sul divano",
          width: 576,
          height: 1024,
          model: "z-image-turbo",
          seed: 7,
          stay_on: true,
        })
        expect(path.dirname(path.dirname(sent.file))).toBe(test.directory)
        expect(path.basename(path.dirname(sent.file))).toBe("images")
        expect(path.basename(sent.file)).toBe("gatto-rosso-sul-divano.png")

        const part = toolPart(answered.parts)
        expect(part.state.status).toBe("completed")
        if (part.state.status !== "completed") return
        expect(part.state.input).toEqual({
          request: "un gatto rosso sul divano",
          format: "portrait",
          size: "small",
          model: "z-image-turbo",
          seed: 7,
          prompt: "un gatto rosso sul divano",
          name: "gatto-rosso-sul-divano",
        })
        expect(part.state.title).toBe(path.join("images", "gatto-rosso-sul-divano.png"))
        expect(part.state.metadata).toEqual({
          file: sent.file,
          width: 576,
          height: 1024,
          seed: 42,
          model: "z-image-turbo",
          request: "un gatto rosso sul divano",
          prompt: "un gatto rosso sul divano",
        })
        expect(part.state.output).toContain("images")
        expect(part.state.attachments).toMatchObject([
          {
            type: "file",
            mime: "image/png",
            filename: "gatto-rosso-sul-divano.png",
            url: `data:image/png;base64,${PNG}`,
          },
        ])
        // The words name a conversation that has no name yet.
        expect(Session.isDefaultTitle((yield* (yield* Session.Service).get(chat.id)).title)).toBe(false)
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "the description the model wrote is what the app draws and what the part holds",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("PROMPT: A red cat on a sofa,\nphotograph.")
        const { prompt, chat } = yield* boot()
        yield* prompt
          .image({ sessionID: chat.id, request: "un gatto rosso sul divano" })
          .pipe(Effect.ensuring(fake.stop))

        expect(fake.generated().prompt).toBe("A red cat on a sofa, photograph.")
        expect(engine.seen).toHaveLength(1)
        expect(engine.seen[0].messages.at(-1)).toMatchObject({ role: "user", content: "un gatto rosso sul divano" })
        const part = toolPart((yield* messages(chat.id))[1].parts)
        expect(part.state.status).toBe("completed")
        if (part.state.status !== "completed") return
        expect(part.state.input).toMatchObject({
          request: "un gatto rosso sul divano",
          prompt: "A red cat on a sofa, photograph.",
          name: "gatto-rosso-sul-divano",
        })
        expect(part.state.metadata).toMatchObject({
          request: "un gatto rosso sul divano",
          prompt: "A red cat on a sofa, photograph.",
        })
        expect(path.basename(fake.generated().file)).toBe("gatto-rosso-sul-divano.png")
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a description already written is drawn as it is: nobody rewrites it",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("PROMPT: not this one")
        const { prompt, chat } = yield* boot()
        yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", prompt: "A tabby cat, studio photograph." })
          .pipe(Effect.ensuring(fake.stop))

        expect(engine.seen).toHaveLength(0)
        expect(fake.generated().prompt).toBe("A tabby cat, studio photograph.")
        const part = toolPart((yield* messages(chat.id))[1].parts)
        if (part.state.status !== "completed") throw new Error("the picture was not made")
        expect(part.state.input).toMatchObject({ request: "un gatto", prompt: "A tabby cat, studio photograph." })
        expect(part.state.metadata).toMatchObject({ request: "un gatto", prompt: "A tabby cat, studio photograph." })
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a question of the model is asked to the user, and the answer goes back to the model",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("QUESTION: A cosa serve il logo?\nOPTIONS: Insegna | Sito", "PROMPT: A flat logo of a pizzeria.")
        const { prompt, sessions, chat } = yield* boot()
        const turn = yield* prompt
          .image({ sessionID: chat.id, request: "un logo per la pizzeria" })
          .pipe(Effect.ensuring(fake.stop), Effect.forkChild)

        const asked = yield* answer("Insegna")
        expect(asked.sessionID).toBe(chat.id)
        expect(asked.questions).toHaveLength(1)
        expect(asked.questions[0].question).toBe("A cosa serve il logo?")
        expect(asked.questions[0].options.map((option) => option.label)).toEqual(["Insegna", "Sito"])
        const result = yield* Fiber.join(turn)

        // The dock shows the question at the picture's part.
        expect(asked.tool).toEqual({ messageID: result.info.id, callID: toolPart(result.parts).callID })
        expect(engine.seen).toHaveLength(2)
        expect(engine.seen[1].messages.slice(1)).toMatchObject([
          { role: "user", content: "un logo per la pizzeria" },
          { role: "assistant", content: "QUESTION: A cosa serve il logo?\nOPTIONS: Insegna | Sito" },
          { role: "user", content: "Insegna" },
        ])
        expect(fake.generated().prompt).toBe("A flat logo of a pizzeria.")
        expect(fake.seen.filter((request) => request.path === "/control/image/generate")).toHaveLength(1)
        yield* assertFree((yield* sessions.get(chat.id)).id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a model that keeps asking is asked no more after three answers, and must describe",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say(
          "QUESTION: One?\nOPTIONS: a | b",
          "QUESTION: Two?\nOPTIONS: a | b",
          "QUESTION: Three?\nOPTIONS: a | b",
          "PROMPT: A logo.",
        )
        const { prompt, chat } = yield* boot()
        const turn = yield* prompt
          .image({ sessionID: chat.id, request: "un logo" })
          .pipe(Effect.ensuring(fake.stop), Effect.forkChild)
        yield* answer("a")
        yield* answer("b")
        yield* answer("a")
        yield* Fiber.join(turn)

        expect(engine.seen).toHaveLength(4)
        const rules = (n: number) => engine.seen[n].messages[0].content as string
        expect(rules(0)).not.toContain("cannot be asked anything more")
        expect(rules(2)).not.toContain("cannot be asked anything more")
        expect(rules(3)).toContain("cannot be asked anything more")
        expect(engine.seen[3].messages).toHaveLength(1 + 1 + 3 * 2)
        expect(fake.generated().prompt).toBe("A logo.")
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a question that is dismissed leaves the choice to the model: it is asked nothing more and the picture is made",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("QUESTION: One?\nOPTIONS: a | b", "PROMPT: A logo.")
        const { prompt, chat } = yield* boot()
        const question = yield* Question.Service
        const turn = yield* prompt
          .image({ sessionID: chat.id, request: "un logo" })
          .pipe(Effect.ensuring(fake.stop), Effect.forkChild)
        const asked = yield* pollWithTimeout(
          question.list().pipe(Effect.map((all) => (all.length ? all[0] : undefined))),
          "the turn never asked a question",
        )
        yield* question.reject(asked.id)
        yield* Fiber.join(turn)

        const part = (yield* picturePart(chat.id))!
        expect(part.type === "tool" && part.state.status).toBe("completed")
        expect(engine.seen).toHaveLength(2)
        expect(engine.seen[1].messages[0].content as string).toContain("cannot be asked anything more")
        expect(engine.seen[1].messages.at(-1)).toMatchObject({
          role: "user",
          content: expect.stringMatching(/no preference|nessuna preferenza/),
        })
        expect(fake.generated().prompt).toBe("A logo.")
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a model that cannot rewrite ends the turn with its sentence",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("Sure! Here is a lovely picture for you.")
        const { prompt, chat } = yield* boot()
        yield* prompt.image({ sessionID: chat.id, request: "un gatto" }).pipe(Effect.ensuring(fake.stop))

        const part = (yield* picturePart(chat.id))!
        if (part.type !== "tool" || part.state.status !== "error") throw new Error("the part should be an error")
        expect(part.state.error).toContain("did not answer in the form asked")
        expect(fake.generated()).toBeUndefined()
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a picture that fails ends the part with the sentence of the app, and the session is free",
    () =>
      Effect.gen(function* () {
        const fake = control("failed")
        const { prompt, chat } = yield* boot()
        const result = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: false })
          .pipe(Effect.ensuring(fake.stop))

        const part = toolPart(result.parts)
        expect(part.state.status).toBe("error")
        if (part.state.status !== "error") return
        expect(part.state.error).toBe("Not enough memory on the card. CUDA out of memory")
        expect(part.state.input).toMatchObject({ request: "un gatto", prompt: "un gatto" })
        expect(result.info).toMatchObject({ role: "assistant", time: { completed: expect.any(Number) } })
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "without the app the part says that pictures are made by it",
    () =>
      Effect.gen(function* () {
        const fake = control()
        yield* fake.stop
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.image({ sessionID: chat.id, request: "un gatto", rewrite: false })

        const part = toolPart(result.parts)
        if (part.state.status !== "error") throw new Error("the part should be an error")
        expect(part.state.error).toContain("The Mango Code app is not answering")
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "an agent that the app did not start has no one to draw: the part says so before a model is asked to write",
    () =>
      Effect.gen(function* () {
        delete process.env.MANGO_CONTROL_URL
        engine.say("PROMPT: A cat.")
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.image({ sessionID: chat.id, request: "un gatto" })

        const part = toolPart(result.parts)
        if (part.state.status !== "error") throw new Error("the part should be an error")
        expect(part.state.error).toBe("Pictures are made by the Mango Code app, and this agent was not started by it.")
        expect(engine.seen).toHaveLength(0)
        yield* assertFree(chat.id)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "the part shows each step with its small picture, and the session is busy meanwhile",
    () =>
      Effect.gen(function* () {
        const fake = control("never")
        const { prompt, chat } = yield* boot()
        const turn = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: false })
          .pipe(Effect.ensuring(fake.stop), Effect.forkChild)

        const drawing = yield* pollWithTimeout(
          picturePart(chat.id).pipe(
            Effect.map((part) =>
              part?.type === "tool" && part.state.status === "running" && part.state.metadata?.stage === "drawing"
                ? part
                : undefined,
            ),
          ),
          "the part never reached the drawing",
        )
        if (drawing.type !== "tool" || drawing.state.status !== "running") throw new Error("not running")
        expect(drawing.state.metadata).toMatchObject({
          stage: "drawing",
          steps: 8,
          preview: PNG,
          width: 768,
          height: 768,
        })
        expect(drawing.state.metadata?.step).toBeGreaterThanOrEqual(1)
        expect(drawing.state.title).toMatch(/\(\d\/8\)$/)
        expect(drawing.state.input).toMatchObject({ request: "un gatto", prompt: "un gatto", name: "gatto" })

        const second = yield* prompt.image({ sessionID: chat.id, request: "un cane", rewrite: false }).pipe(Effect.exit)
        expect(Exit.isFailure(second) && Cause.squash(second.cause)).toMatchObject({ _tag: "SessionBusyError" })

        yield* prompt.cancel(chat.id)
        yield* Fiber.join(turn)
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "aborting the session cancels the picture in the app and ends the part as stopped",
    () =>
      Effect.gen(function* () {
        const fake = control("never")
        const { prompt, chat } = yield* boot()
        const turn = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: false })
          .pipe(Effect.ensuring(fake.stop), Effect.forkChild)
        yield* pollWithTimeout(
          Effect.sync(() =>
            fake.seen.some((request) => request.path === "/control/image/jobs/image-1") ? true : undefined,
          ),
          "the job was never followed",
        )

        yield* prompt.cancel(chat.id)
        yield* assertFree(chat.id)
        const result = yield* Fiber.join(turn)

        expect(
          fake.seen.some(
            (request) => request.method === "POST" && request.path === "/control/image/jobs/image-1/cancel",
          ),
        ).toBe(true)
        const part = toolPart(result.parts)
        expect(part.state.status).toBe("error")
        if (part.state.status !== "error") return
        expect(part.state.error).toBe("The picture was stopped.")
        expect(part.state.metadata).toMatchObject({ stopped: true })
        expect(result.info).toMatchObject({ role: "assistant", time: { completed: expect.any(Number) } })
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a later turn of the model finds the picture in the history like any tool call",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        yield* prompt
          .image({ sessionID: chat.id, request: "un gatto rosso", rewrite: false })
          .pipe(Effect.ensuring(fake.stop))

        engine.say("It is a red cat.")
        yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "cosa hai disegnato?" }] })

        const sent = engine.seen.at(-1).messages as any[]
        const roles = sent.filter((message) => message.role !== "system").map((message) => message.role)
        expect(roles).toEqual(["user", "assistant", "tool", "user"])
        const [first, call, result, next] = sent.filter((message) => message.role !== "system")
        expect(first.content).toContain("un gatto rosso")
        expect(call.tool_calls).toHaveLength(1)
        expect(call.tool_calls[0].function.name).toBe("image_generate")
        expect(JSON.parse(call.tool_calls[0].function.arguments)).toMatchObject({
          request: "un gatto rosso",
          prompt: "un gatto rosso",
        })
        expect(result.tool_call_id).toBe(call.tool_calls[0].id)
        // The model of this conversation cannot read images: it is told that there is one, not given it.
        expect(JSON.stringify(result.content)).toContain("Picture saved as")
        expect(JSON.stringify(result.content)).toContain("you cannot see images")
        expect(JSON.stringify(result.content)).not.toContain(PNG)
        expect(next.content).toContain("cosa hai disegnato?")
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "the result of the turn only says what was made, also for a model that reads images",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        const result = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto rosso", rewrite: false })
          .pipe(Effect.ensuring(fake.stop))

        const part = toolPart(result.parts)
        if (part.state.status !== "completed") throw new Error("the picture was not made")
        expect(part.state.output).toMatch(/^Picture saved as .*\.png \(768x768\)\.$/)

        engine.say("It is a red cat.")
        yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "aggiungi un cappello" }] })
        const sent = (engine.seen.at(-1).messages as any[]).filter((message) => message.role !== "system")
        expect(JSON.stringify(sent.find((message) => message.role === "tool").content)).not.toContain("Look at it")
      }),
    { git: true, config: seeing },
    60_000,
  )

  it.instance(
    "the file is named after the person's own words: the first ones, without the article and without a joining word at the cut",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        const named = (request: string) =>
          Effect.gen(function* () {
            yield* prompt.image({ sessionID: chat.id, request, rewrite: false })
            return path.basename(fake.seen.findLast((seen) => seen.path === "/control/image/generate")?.body.file)
          })
        expect(yield* named("Una pizza margherita su un tavolo di legno, vista dall'alto")).toBe("pizza-margherita-su-un-tavolo.png")
        expect(yield* named("Un logo per la pizzeria di Mario, rosso")).toBe("logo-per-la-pizzeria.png")
        expect(yield* named("L'insegna del caffè Città")).toBe("insegna-del-caffe-citta.png")
        expect(yield* named("a blue sky")).toBe("blue-sky.png")
        yield* fake.stop
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "the picture is where the app says it wrote it",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const wrote = path.join(test.directory, "images", "gatto-2.png")
        const fake = control("done", wrote)
        const { prompt, chat } = yield* boot()
        const result = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: false })
          .pipe(Effect.ensuring(fake.stop))

        expect(path.basename(fake.generated().file)).toBe("gatto.png")
        const part = toolPart(result.parts)
        if (part.state.status !== "completed") throw new Error("the picture was not made")
        expect(part.state.title).toBe(path.join("images", "gatto-2.png"))
        expect(part.state.metadata).toMatchObject({ file: wrote })
        expect(part.state.attachments).toMatchObject([{ filename: "gatto-2.png" }])
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "a model removed since it was chosen is replaced by the automatic choice",
    () =>
      Effect.gen(function* () {
        const fake = control()
        engine.say("PROMPT: A red cat.")
        const { prompt, chat } = yield* boot()
        yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: { providerID: ProviderV2.ID.make("mango"), modelID: ModelV2.ID.make("removed") } })
          .pipe(Effect.ensuring(fake.stop))

        expect(engine.seen).toHaveLength(1)
        expect(fake.generated().prompt).toBe("A red cat.")
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "without any model that writes a picture is still made when nothing has to be written",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        const result = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", rewrite: false })
          .pipe(Effect.ensuring(fake.stop))

        expect(toolPart(result.parts).state.status).toBe("completed")
        const [asked, answered] = yield* messages(chat.id)
        expect(asked.info.role === "user" && asked.info.model).toEqual(ImageTurn.NO_MODEL)
        expect(answered.info.role === "assistant" && answered.info.providerID).toBe(ImageTurn.NO_MODEL.providerID)
        yield* assertFree(chat.id)
      }),
    { git: true, config: nothing },
    60_000,
  )

  it.instance(
    "a description written beforehand needs no model either",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        const result = yield* prompt
          .image({ sessionID: chat.id, request: "un gatto", prompt: "A tabby cat." })
          .pipe(Effect.ensuring(fake.stop))

        expect(toolPart(result.parts).state.status).toBe("completed")
        expect(fake.generated().prompt).toBe("A tabby cat.")
      }),
    { git: true, config: nothing },
    60_000,
  )

  it.instance(
    "asking for the words to be rewritten with no model that writes is an error part with a sentence",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.image({ sessionID: chat.id, request: "un gatto" }).pipe(Effect.ensuring(fake.stop))

        const part = toolPart(result.parts)
        if (part.state.status !== "error") throw new Error("the part should be an error")
        expect(part.state.error).toBe("there is no model that writes")
        expect(fake.generated()).toBeUndefined()
        yield* assertFree(chat.id)
      }),
    { git: true, config: nothing },
    60_000,
  )

  it.instance(
    "a conversation that began with a picture without a model does not take the placeholder for its model",
    () =>
      Effect.gen(function* () {
        const fake = control()
        const { prompt, chat } = yield* boot()
        // The turn is made while no model is known; the conversation then gets one.
        yield* prompt.image({ sessionID: chat.id, request: "un gatto", rewrite: false }).pipe(Effect.ensuring(fake.stop))
        const asked = yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "ciao" }], noReply: true })

        expect(asked.info.role === "user" && asked.info.model.providerID).toBe(ProviderV2.ID.make("mango"))
      }),
    { git: true, config },
    60_000,
  )

  for (const ending of ["completed", "failed", "stopped"] as const)
    it.instance(
      `the history after a picture turn that ${ending === "completed" ? "was made" : ending} is well formed for the next turn`,
      () =>
        Effect.gen(function* () {
          const fake = control(ending === "failed" ? "failed" : ending === "stopped" ? "never" : "done")
          const { prompt, chat } = yield* boot()
          const turn = yield* prompt
            .image({ sessionID: chat.id, request: "un gatto rosso", rewrite: false })
            .pipe(Effect.ensuring(fake.stop), Effect.forkChild)
          if (ending === "stopped") {
            yield* pollWithTimeout(
              Effect.sync(() =>
                fake.seen.some((request) => request.path === "/control/image/jobs/image-1") ? true : undefined,
              ),
              "the job was never followed",
            )
            yield* prompt.cancel(chat.id)
          }
          yield* Fiber.join(turn)

          engine.say("Fine.")
          yield* prompt.prompt({ sessionID: chat.id, parts: [{ type: "text", text: "aggiungi un cappello" }] })

          const sent = (engine.seen.at(-1).messages as any[]).filter((message) => message.role !== "system")
          expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"])
          const [first, call, result, next] = sent
          expect(first.content).toContain("un gatto rosso")
          expect(call.tool_calls).toHaveLength(1)
          expect(result.tool_call_id).toBe(call.tool_calls[0].id)
          expect(next.content).toContain("aggiungi un cappello")
          const said = JSON.stringify(result.content)
          if (ending === "completed") expect(said).toContain("Picture saved as")
          if (ending === "failed") expect(said).toContain("Not enough memory on the card.")
          if (ending === "stopped") expect(said).toContain("The picture was stopped.")
        }),
      { git: true, config },
      60_000,
    )
})
