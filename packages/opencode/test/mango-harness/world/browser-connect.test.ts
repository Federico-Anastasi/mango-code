import { afterEach, expect, test } from "bun:test"
import { openPanelBrowser } from "@/mango-harness/world/browser"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => {
  server?.stop(true)
  server = undefined
})

/** A debugging port that answers every command but `fails` with an empty result, and that one with an error. */
function port(fails: string) {
  const closed = Promise.withResolvers<void>()
  server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, self) {
      if (new URL(request.url).pathname === "/json/version")
        return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/devtools/browser/fake` })
      return self.upgrade(request) ? undefined : new Response("", { status: 404 })
    },
    websocket: {
      message(socket, data) {
        const { id, method } = JSON.parse(String(data)) as { id: number; method: string }
        const reply =
          method === fails
            ? { id, error: { message: `${method} was refused` } }
            : { id, result: { targetInfos: [{ targetId: "t1", type: "page", url: "about:blank", title: "" }] } }
        socket.send(JSON.stringify(reply))
      },
      close: () => closed.resolve(),
    },
  })
  return { port: server.port, closed: closed.promise }
}

for (const method of ["Target.getTargets", "Target.attachToTarget"])
  test(`a panel that refuses ${method} says so and its connection is not left open`, async () => {
    const fake = port(method)
    const browser = openPanelBrowser({ project: process.cwd(), env: { MANGO_PANEL_CDP: String(fake.port) } })
    const answer = await browser.view("http://127.0.0.1:1/")
    expect(answer).toBeInstanceOf(Error)
    expect((answer as Error).message).toContain(`${method} was refused`)
    expect(await Promise.race([fake.closed.then(() => true), Bun.sleep(3000).then(() => false)])).toBe(true)
  })
