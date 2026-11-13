import { afterAll, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRoot } from "solid-js"
import { createReader } from "./mango"

// A local server stands in for the agent. The first read of the catalog and of the computer, in the language of before,
// waits until the test lets it go; the reads asked while the reader reads again answer at once in the new language; any
// other read never answers, so nothing reads the right words again after the late answer.
const reads = { models: 0, computer: 0 }
const late = Promise.withResolvers<void>()
let rereading = false
const entry = (label: string) => ({
  key: "a",
  label,
  present: true,
  bytes: 1,
  verdict: { fits: true, where: null, reason: "", speed: null, fastest: false },
  choices: { where: "auto", gpus: [], context: null, style: "recommended", reasoning: null },
  limits: { where: ["auto"], context: [32768], reasoning: false },
})
const computer = (cpu: string) => ({
  gpus: [],
  cpu,
  cores: 8,
  ram_mib: 1024,
  disk: { path: "C:\\m", used_bytes: 1, free_bytes: 1 },
  engine: { label: "llama.cpp", installed: true },
})
const server = http.createServer(async (request, response) => {
  // the page's fetch asks first whether it may (another origin)
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*" })
    return response.end()
  }
  const path = new URL(request.url ?? "", "http://localhost").pathname
  const revision = reads.models === 0 ? 1 : 2
  const answer = (body: unknown) => {
    response.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
    response.end(JSON.stringify(body))
  }
  if (path === "/mango/state")
    return answer({
      revision,
      catalog_revision: revision,
      model: { phase: "none" },
      default_model: null,
      downloads: [],
    })
  const first = path === "/mango/models" ? reads.models++ === 0 : reads.computer++ === 0
  if (!first && !rereading) return
  if (first) await late.promise
  const words = first ? "it" : "en"
  answer(path === "/mango/models" ? { models: [entry(words)] } : computer(words))
})
await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

test("a read of the catalog and of the computer that arrives after a newer one is left out", async () => {
  const { reader, dispose } = createRoot((dispose) => ({ reader: createReader(() => ({ url, http: {} })), dispose }))
  const shown = () => `${reader.catalog()?.[0].label} ${reader.computer()?.cpu}`
  // the loop's first read is under way, in Italian; the language changes and the reader reads again at once
  while (reads.models === 0 || reads.computer === 0) await Bun.sleep(10)
  rereading = true
  await reader.refresh()
  rereading = false
  expect(shown()).toBe("en en")
  // the Italian answers arrive after it, and are left out
  late.resolve()
  await Bun.sleep(200)
  expect(shown()).toBe("en en")
  dispose()
})
