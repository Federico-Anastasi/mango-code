import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// mango-code: the routes of the model, the models and the computer go to the app's control server, announced in
// MANGO_CONTROL_URL, and return its status and body.
const original = process.env.MANGO_CONTROL_URL

afterEach(async () => {
  if (original === undefined) delete process.env.MANGO_CONTROL_URL
  else process.env.MANGO_CONTROL_URL = original
  await disposeAllInstances()
  await resetDatabase()
})

/** A fake control server: answers every request with what `reply` says, and remembers what it received. */
function control(reply: (path: string) => { status: number; body: unknown } | Promise<never>) {
  const seen: { method: string; path: string; body: string; origin: string | null }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname
      seen.push({ method: request.method, path, body: await request.text(), origin: request.headers.get("origin") })
      const answer = await reply(path)
      return Response.json(answer.body, { status: answer.status })
    },
  })
  process.env.MANGO_CONTROL_URL = `http://127.0.0.1:${server.port}`
  return { server, seen }
}

const request = (path: string, init?: RequestInit) => Server.Default().app.request(path, init)

describe("the routes of the control server", () => {
  test("each route goes to its control route, with the status and the body of the answer", async () => {
    const fake = control((path) =>
      path === "/control/model/use"
        ? { status: 409, body: { error: { message: "another PC", type: "mango_engine" } } }
        : { status: 200, body: { answered: path } },
    )
    try {
      for (const [path, target] of [
        ["/mango/state", "/control/state"],
        ["/mango/models", "/control/models"],
        ["/mango/computer", "/control/computer"],
      ]) {
        // A page sends Origin, which the control server refuses: it does not go on.
        const response = await request(path, { headers: { origin: "http://127.0.0.1:4096", host: "127.0.0.1:4096" } })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ answered: target })
      }
      const use = await request("/mango/model/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "3.6", once: true }),
      })
      expect(use.status).toBe(409)
      expect(await use.json()).toEqual({ error: { message: "another PC", type: "mango_engine" } })
      const retry = await request("/mango/model/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
      })
      expect(await retry.json()).toEqual({ answered: "/control/model/retry" })

      expect(fake.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /control/state",
        "GET /control/models",
        "GET /control/computer",
        "POST /control/model/use",
        "POST /control/model/retry",
      ])
      expect(JSON.parse(fake.seen[3].body)).toEqual({ model: "3.6", once: true })
      expect(fake.seen[4].body).toBe("")
      expect(fake.seen.every((r) => r.origin === null)).toBe(true)
    } finally {
      fake.server.stop(true)
    }
  })

  test("a picture is asked, followed, fetched and cancelled by the number of its job", async () => {
    const fake = control((path) => (path === "/control/image/generate" ? { status: 202, body: { id: "image-3" } } : { status: 200, body: { answered: path } }))
    const json = { method: "POST", headers: { "content-type": "application/json" } }
    try {
      expect(await (await request("/mango/image")).json()).toEqual({ answered: "/control/image" })
      const asked = await request("/mango/image/generate", { ...json, body: JSON.stringify({ prompt: "a cat", width: 512, height: 512 }) })
      expect(asked.status).toBe(202)
      expect(await asked.json()).toEqual({ id: "image-3" })
      expect(await (await request("/mango/image/jobs/image-3")).json()).toEqual({ answered: "/control/image/jobs/image-3" })
      expect((await request("/mango/image/jobs/image-3/picture")).status).toBe(200)
      expect((await request("/mango/image/jobs/image-3/cancel", json)).status).toBe(200)
      expect((await request("/mango/image/unload", json)).status).toBe(200)

      expect(fake.seen.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /control/image",
        "POST /control/image/generate",
        "GET /control/image/jobs/image-3",
        "GET /control/image/jobs/image-3/picture",
        "POST /control/image/jobs/image-3/cancel",
        "POST /control/image/unload",
      ])
      expect(JSON.parse(fake.seen[1].body)).toEqual({ prompt: "a cat", width: 512, height: 512 })
    } finally {
      fake.server.stop(true)
    }
  })

  test("the number of a job cannot lead to another route of the control server", async () => {
    const fake = control(() => ({ status: 200, body: {} }))
    try {
      for (const id of ["..%2F..%2Fmodel", "%2e%2e", "image-3.png", "a%20b"])
        expect((await request(`/mango/image/jobs/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(404)
      expect(fake.seen).toHaveLength(0)
    } finally {
      fake.server.stop(true)
    }
  })

  test("the type of the answer is the control server's, and a body over 16 KB is refused", async () => {
    const seen: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen.push(new URL(request.url).pathname)
        return new Response("not json", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } })
      },
    })
    process.env.MANGO_CONTROL_URL = `http://127.0.0.1:${server.port}`
    try {
      const response = await request("/mango/state")
      expect(response.status).toBe(500)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await response.text()).toBe("not json")
      const big = await request("/mango/model/use", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x".repeat(17 * 1024) }),
      })
      expect(big.status).toBe(413)
      expect(seen).toEqual(["/control/state"])
    } finally {
      server.stop(true)
    }
  })

  test("an agent the app did not start answers 503", async () => {
    delete process.env.MANGO_CONTROL_URL
    const response = await request("/mango/state")
    expect(response.status).toBe(503)
    expect((await response.json()).error.type).toBe("mango_control")
  })

  test("a control server that is not there answers 503", async () => {
    const fake = control(() => ({ status: 200, body: {} }))
    fake.server.stop(true)
    const response = await request("/mango/models")
    expect(response.status).toBe(503)
  })

  test("a control server that does not answer gives 503 within the time limit", async () => {
    const fake = control(() => new Promise<never>(() => {}))
    try {
      const started = Date.now()
      const response = await request("/mango/computer")
      expect(response.status).toBe(503)
      expect(Date.now() - started).toBeLessThan(15_000)
    } finally {
      fake.server.stop(true)
    }
  }, 20_000)

  test("the menu's old route is gone", async () => {
    const fake = control(() => ({ status: 200, body: {} }))
    try {
      expect((await request("/mango/models/info")).status).toBe(404)
      expect(fake.seen).toHaveLength(0)
    } finally {
      fake.server.stop(true)
    }
  })
})
