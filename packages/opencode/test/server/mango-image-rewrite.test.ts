import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { REWRITE_PATH, read } from "../../src/server/shared/mango-image-rewrite"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// mango-code: a request for a picture goes to a model that writes, with the rules as its instructions, and comes back
// as the description for the image model or as a question. The engine here is a fake one that answers what the test
// says and remembers what it was sent.
const servers: { stop: (force?: boolean) => void }[] = []

afterEach(async () => {
  servers.splice(0).forEach((server) => server.stop(true))
  await disposeAllInstances()
  await resetDatabase()
})

function engine(reply: string | number) {
  const seen: any[] = []
  const headers: Headers[] = []
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      headers.push(request.headers)
      seen.push(await request.json())
      if (typeof reply === "number") return new Response("the engine is not well", { status: reply })
      return new Response(chunk({ role: "assistant", content: reply }) + chunk({}, "stop") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  servers.push(server)
  return { seen, headers, url: `http://127.0.0.1:${server.port}/v1` }
}

const project = (url: string, models: string[]) =>
  tmpdir({
    git: true,
    config: {
      enabled_providers: ["mango"],
      provider: {
        mango: {
          name: "mango-code",
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "dummy", baseURL: url },
          models: Object.fromEntries(
            models.map((name) => [name, { name, tool_call: true, attachment: false, temperature: true, limit: { context: 32768, output: 4096 } }]),
          ),
        },
      },
    },
  })

const rewrite = (directory: string, body: unknown) =>
  Server.Default().app.request(`${REWRITE_PATH}?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("a request for a picture is rewritten", () => {
  test("Ling writes it when it is on the computer, with the rules, without reasoning", async () => {
    const fake = engine("PROMPT: A photograph of a red Vespa\nparked in front of the Colosseum, soft morning light.")
    await using tmp = await project(fake.url, ["local", "ling"])
    const response = await rewrite(tmp.path, { request: "una vespa rossa davanti al colosseo" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      prompt: "A photograph of a red Vespa parked in front of the Colosseum, soft morning light.",
      model: { providerID: "mango", modelID: "ling" },
    })
    const sent = fake.seen[0]
    expect(sent.model).toBe("ling")
    // The rules are all the model is told: not Mango Code's own prompt before them.
    expect(sent.messages[0].role).toBe("system")
    expect(sent.messages[0].content).toStartWith("You pass a person's request for a picture on to an image model.")
    expect(sent.messages[0].content.trimEnd()).toEndWith("choosing those is your job.")
    expect(sent.messages).toHaveLength(2)
    expect(sent.messages.at(-1)).toMatchObject({ role: "user", content: "una vespa rossa davanti al colosseo" })
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(sent.temperature).toBe(0.7)
    expect(sent.top_p).toBe(0.8)
    expect(sent.tools).toBeUndefined()
  })

  test("without Ling the agent's model writes it, and a model the request names writes it instead", async () => {
    const fake = engine("PROMPT: A cat.")
    await using alone = await project(fake.url, ["local"])
    expect((await (await rewrite(alone.path, { request: "un gatto" })).json()).model).toEqual({ providerID: "mango", modelID: "local" })

    await using both = await project(fake.url, ["local", "ling"])
    const named = await rewrite(both.path, { request: "un gatto", model: { providerID: "mango", modelID: "local" } })
    expect((await named.json()).model).toEqual({ providerID: "mango", modelID: "local" })
    expect(fake.seen.map((sent) => sent.model)).toEqual(["local", "local"])
  })

  test("the request to the engine says it is a side request, so that the conversations keep their model", async () => {
    const fake = engine("PROMPT: A cat.")
    await using tmp = await project(fake.url, ["local", "ling"])
    await rewrite(tmp.path, { request: "un gatto" })
    await rewrite(tmp.path, { request: "un gatto", model: { providerID: "mango", modelID: "local" } })
    expect(fake.headers.map((headers) => headers.get("x-mango-side-request"))).toEqual(["1", "1"])
  })

  test("a question comes back with its answers, and the answer goes on with the conversation", async () => {
    const fake = engine("QUESTION: A cosa serve il logo?\nOPTIONS: Insegna | Biglietto da visita | Sito")
    await using tmp = await project(fake.url, ["ling"])
    const first = await (await rewrite(tmp.path, { request: "un logo per la pizzeria" })).json()
    expect(first).toMatchObject({ question: "A cosa serve il logo?", options: ["Insegna", "Biglietto da visita", "Sito"] })

    await rewrite(tmp.path, {
      request: "un logo per la pizzeria",
      answers: [{ question: first.question, options: first.options, answer: "Insegna" }],
    })
    expect(fake.seen[1].messages.slice(1)).toMatchObject([
      { role: "user", content: "un logo per la pizzeria" },
      { role: "assistant", content: "QUESTION: A cosa serve il logo?\nOPTIONS: Insegna | Biglietto da visita | Sito" },
      { role: "user", content: "Insegna" },
    ])
  })

  test("a model that answers out of form, or not at all, is an error that says which model", async () => {
    const chatty = engine("Sure! Here is a lovely picture of a cat for you.")
    await using tmp = await project(chatty.url, ["ling"])
    const out = await rewrite(tmp.path, { request: "un gatto" })
    expect(out.status).toBe(502)
    expect((await out.json()).error).toMatchObject({ type: "mango_image" })

    const broken = engine(500)
    await using other = await project(broken.url, ["ling"])
    expect((await rewrite(other.path, { request: "un gatto" })).status).toBe(502)
  }, 60_000)

  test("no model, no request and no folder are told apart", async () => {
    const fake = engine("PROMPT: A cat.")
    await using empty = await tmpdir({ git: true, config: { enabled_providers: ["mango"] } })
    expect((await rewrite(empty.path, { request: "un gatto" })).status).toBe(404)

    await using tmp = await project(fake.url, ["ling"])
    expect((await rewrite(tmp.path, { request: "  " })).status).toBe(400)
    expect((await rewrite(tmp.path, { text: "un gatto" })).status).toBe(400)
    expect((await rewrite(tmp.path, { request: "un gatto", model: { providerID: "mango", modelID: "missing" } })).status).toBe(404)
    expect(fake.seen).toHaveLength(0)
  })

  test("what the model wrote is read without its reasoning and on one line", () => {
    expect(read("<think>a cat, fine</think>\nPROMPT:  A cat\n  on a sofa. ")).toEqual({ prompt: "A cat on a sofa." })
    expect(read("QUESTION: Che nome ha?\nOPTIONS: Da Gino | Non ha nome")).toEqual({ question: "Che nome ha?", options: ["Da Gino", "Non ha nome"] })
    expect(read("QUESTION: Che nome ha?")).toEqual({ question: "Che nome ha?", options: [] })
    expect(read("A cat on a sofa.")).toBeUndefined()
    expect(read("PROMPT:")).toBeUndefined()
  })
})
