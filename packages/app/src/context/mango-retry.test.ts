import { afterAll, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRoot } from "solid-js"
import { createReader } from "./mango"

// A local server stands in for the agent: like its origin guard, it takes a POST only as JSON, and «retry» starts the
// model whose start failed.
let retried = false
const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" })
    return response.end()
  }
  const answer = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" })
    response.end(JSON.stringify(body))
  }
  const path = new URL(request.url ?? "", "http://localhost").pathname
  if (request.method === "POST" && request.headers["content-type"] !== "application/json")
    return answer(415, { error: "the request must be JSON" })
  if (request.method === "POST" && path === "/mango/model/retry") retried = true
  if (path !== "/mango/state" && path !== "/mango/model/retry") return
  answer(200, {
    revision: retried ? 2 : 1,
    catalog_revision: 0,
    model: retried
      ? { phase: "loading", model: "a", label: "A", seconds: 0, where: null }
      : { phase: "failed", model: "a", label: "A", reason: "it does not start", taken: null, proposal: null },
    default_model: "a",
    downloads: [],
  })
})
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

test("«Riprova» reaches the agent, which takes it as JSON though it has no body, and the model shown is loading", async () => {
  const { reader, dispose } = createRoot((dispose) => ({ reader: createReader(() => ({ url, http: {} })), dispose }))
  await reader.retry()
  expect(retried).toBe(true)
  expect(reader.state()?.model.phase).toBe("loading")
  dispose()
})
