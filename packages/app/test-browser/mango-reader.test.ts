import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createEffect, createRoot } from "solid-js"
import { createReader } from "@/context/mango"

// mango-code: how the interface reads the app's state through the agent, against a small agent
// that answers what each test tells it.
type Answer = { status: number; body?: unknown }

async function agent() {
  const answers = { state: [] as Answer[], models: [] as Answer[], computer: [computer] as Answer[], use: [] as Answer[] }
  const asked = { state: 0, models: 0, computer: 0, use: 0 }
  const next = (list: Answer[]) => (list.length > 1 ? list.shift()! : list[0])
  // node's server: the page's globals (happy-dom) replace the Response that Bun.serve wants
  const server = createServer((request, response) => {
    // the page's fetch asks first whether another origin may read
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" })
      return response.end()
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
    const kinds = {
      "/mango/state": "state",
      "/mango/models": "models",
      "/mango/computer": "computer",
      "/mango/model/use": "use",
    } as const
    const kind = kinds[path as keyof typeof kinds]
    const answer = kind ? (asked[kind]++, next(answers[kind]) ?? { status: 503 }) : { status: 404 }
    response.writeHead(answer.status, { "content-type": "application/json", "access-control-allow-origin": "*" })
    response.end(JSON.stringify(answer.body ?? {}))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, answers, asked, stop: () => server.close() }
}

const state = (revision: number, model: object, extra: object = {}) => ({
  status: 200,
  body: { revision, catalog_revision: 1, model, default_model: "3.6", downloads: [], ...extra },
})
const catalog = {
  status: 200,
  body: {
    models: [
      {
        key: "3.6",
        label: "Qwen",
        present: true,
        verdict: { fits: true },
        choices: { where: "auto", gpus: [], context: null, style: "recommended", reasoning: null },
        limits: { where: ["auto"], context: [], reasoning: false },
      },
    ],
  },
}
const computer = {
  status: 200,
  body: {
    gpus: [{ name: "RTX 3060 Ti", memory_mib: 8192, used: true, note: "" }],
    cpu: "Intel Core i7",
    cores: 8,
    ram_mib: 40960,
    disk: { path: "C:\\Mango\\models", used_bytes: 1, free_bytes: 2 },
    engine: { label: "llama.cpp", installed: true },
  },
}

let stops: (() => void)[] = []
afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
})

function read(url: string) {
  return createRoot((dispose) => {
    stops.push(dispose)
    return createReader(() => ({ url, http: {} }))
  })
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("the app's state, read through the agent", () => {
  test("a catalog that did not come is asked again at the next read, not only when its revision changes", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(1, { phase: "none" }))
    fake.answers.models.push({ status: 503 }, catalog)
    const reader = read(fake.url)
    await until(() => fake.asked.models === 1)
    expect(reader.catalog()).toBeUndefined()
    await reader.refresh()
    expect(reader.catalog()?.map((m) => m.key)).toEqual(["3.6"])
  })

  test("the computer is read with the catalog; one that does not read is asked again at every read until it reads", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(1, { phase: "none" }))
    fake.answers.models.push(catalog)
    fake.answers.computer.splice(0, 1, { status: 503 })
    const reader = read(fake.url)
    await until(() => reader.computerFailed())
    expect(reader.computer()).toBeUndefined()
    expect(fake.asked.models).toBe(1)
    // a read of the state (the window shown again) asks the computer again, not the catalog
    fake.answers.computer.splice(0, 1, computer)
    document.dispatchEvent(new Event("visibilitychange"))
    await until(() => reader.computer() !== undefined)
    expect(reader.computer()?.cpu).toBe("Intel Core i7")
    expect(reader.computerFailed()).toBe(false)
    expect(fake.asked.models).toBe(1)
    // read, it waits for the catalog's revision
    const asked = fake.asked.computer
    document.dispatchEvent(new Event("visibilitychange"))
    await until(() => fake.asked.state === 3)
    expect(fake.asked.computer).toBe(asked)
  })

  test("a catalog whose models all fail to read is said unreadable, not empty, and is asked again until it reads", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(1, { phase: "none" }))
    fake.answers.models.push({ status: 200, body: { models: [{ key: "3.6", present: true }] } }, catalog)
    const reader = read(fake.url)
    await until(() => reader.catalogFailed())
    expect(reader.catalog()).toBeUndefined()
    await reader.refresh()
    expect(reader.catalog()?.map((m) => m.key)).toEqual(["3.6"])
    expect(reader.catalogFailed()).toBe(false)
  })

  test("an app without answer: failed once a read went unanswered and no state is shown", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push({ status: 503 })
    const reader = read(fake.url)
    expect(reader.failed()).toBe(false)
    await until(() => fake.asked.state === 1)
    await until(() => reader.failed())
    expect(reader.failed()).toBe(true)
  })

  test("an answer older than the state shown is left out", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(5, { phase: "loading", model: "ling", label: "Ling", seconds: 1, where: null }))
    fake.answers.models.push(catalog)
    const reader = read(fake.url)
    await until(() => reader.state()?.revision === 5)
    fake.answers.state.splice(
      0,
      1,
      state(4, { phase: "ready", model: "3.6", label: "Qwen", where: { placement: "cpu", gpus: [], context: 4096 } }),
    )
    await reader.refresh()
    expect(reader.state()?.model).toMatchObject({ phase: "loading", model: "ling" })
  })

  test("an app that stops answering is no longer shown after three reads", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(1, { phase: "none" }))
    fake.answers.models.push(catalog)
    const reader = read(fake.url)
    await until(() => reader.state() !== undefined)
    fake.answers.state.splice(0, 1, { status: 503 })
    await reader.refresh()
    await reader.refresh()
    expect(reader.state()).toBeDefined()
    await reader.refresh()
    expect(reader.state()).toBeUndefined()
  })

  test("«Downloaded.» is said for a model seen downloading until its load ends; «ready» is said once after a load", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    const active = { model: "3.6", label: "Qwen", state: "active", done: 1, total: 2, bytes_per_second: 1, error: null }
    const paused = { ...active, model: "ling", state: "paused" }
    fake.answers.state.push(state(1, { phase: "none" }, { downloads: [active, paused] }))
    fake.answers.models.push(catalog)
    const reader = read(fake.url)
    await until(() => reader.state() !== undefined)
    expect([...reader.downloaded()]).toEqual(["3.6"])

    fake.answers.state.splice(
      0,
      1,
      state(2, { phase: "loading", model: "3.6", label: "Qwen", seconds: 1, where: null }),
    )
    await reader.refresh()
    expect([...reader.downloaded()]).toEqual(["3.6"])
    expect(reader.justReady()).toBe(false)

    const where = { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 65536 }
    fake.answers.state.splice(0, 1, state(3, { phase: "ready", model: "3.6", label: "Qwen", where }))
    await reader.refresh()
    expect([...reader.downloaded()]).toEqual([])
    expect(reader.justReady()).toBe(true)
    reader.dismissReady()
    expect(reader.justReady()).toBe(false)
  })

  test("after a read without answer the app may have started again: a lower revision is shown", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(50, { phase: "none" }))
    fake.answers.models.push(catalog)
    const reader = read(fake.url)
    await until(() => reader.state()?.revision === 50)
    fake.answers.state.splice(0, 1, { status: 503 })
    await reader.refresh()
    fake.answers.state.splice(
      0,
      1,
      state(1, { phase: "loading", model: "3.6", label: "Qwen", seconds: 1, where: null }),
    )
    await reader.refresh()
    expect(reader.state()).toMatchObject({ revision: 1, model: { phase: "loading" } })
    // and, the gap closed, an older answer is left out again
    fake.answers.state.splice(0, 1, state(0, { phase: "none" }))
    await reader.refresh()
    expect(reader.state()?.revision).toBe(1)
  })

  test("the model asked is still «asked» when the state that answers it is shown", async () => {
    const fake = await agent()
    stops.push(fake.stop)
    fake.answers.state.push(state(1, { phase: "loading", model: "3.6", label: "Qwen", seconds: 1, where: null }))
    fake.answers.models.push(catalog)
    fake.answers.use.push(state(2, { phase: "loading", model: "ling", label: "Ling", seconds: 0, where: null }))
    const reader = read(fake.url)
    await until(() => reader.state() !== undefined)
    const seen: (string | undefined)[] = []
    createRoot(() =>
      createEffect(() => {
        const model = reader.state()?.model
        if (model?.phase === "loading" && model.model === "ling") seen.push(reader.asked())
      }),
    )
    await reader.use("ling")
    expect(seen).toEqual(["ling"])
    expect(reader.asked()).toBeUndefined()
  })
})
