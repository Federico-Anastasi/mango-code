import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import {
  isForeignApiNavigation,
  isLocalHost,
  isTrustedOrigin,
  originGuard,
} from "../../src/server/routes/instance/httpapi/middleware/origin-guard"
import { ServerAuth } from "../../src/server/auth"

test("only the web UI of the same server, the app and whoever sends no Origin", () => {
  expect(isTrustedOrigin(undefined, "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("http://127.0.0.1:4096", "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("tauri://localhost", "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("https://foreign-site.example", "127.0.0.1:4096")).toBe(false)
  // another local port: the dev server of a project
  expect(isTrustedOrigin("http://localhost:3000", "127.0.0.1:4096")).toBe(false)
  expect(isTrustedOrigin("http://127.0.0.1:5173", "127.0.0.1:4096")).toBe(false)
  expect(isTrustedOrigin("null", "127.0.0.1:4096")).toBe(false)
})

test("a Host is local only when it names the loopback", () => {
  for (const host of ["127.0.0.1:4096", "localhost:4096", "[::1]:4096", "127.0.0.1", "localhost", "LOCALHOST:4096"])
    expect(isLocalHost(host)).toBe(true)
  for (const host of [
    "evil.example:4096",
    "evil.example",
    "localhost.evil.example:4096",
    "127.0.0.1.evil.example:4096",
    "127.0.0.1@evil.example:4096",
    "192.168.1.20:4096",
    "0.0.0.0:4096",
    "",
  ])
    expect(isLocalHost(host)).toBe(false)
})

test("only a navigation to an API address started by another site is refused", () => {
  const navigate = (site: string) => ({ "sec-fetch-site": site, "sec-fetch-mode": "navigate" })
  expect(isForeignApiNavigation(navigate("cross-site"), "/api/fs/read/a.html?x=1")).toBe(true)
  expect(isForeignApiNavigation(navigate("same-site"), "/api")).toBe(true)
  expect(isForeignApiNavigation(navigate("same-origin"), "/api/fs/read/a.html")).toBe(false)
  expect(isForeignApiNavigation(navigate("none"), "/api/fs/read/a.html")).toBe(false)
  expect(isForeignApiNavigation(navigate("cross-site"), "/")).toBe(false)
  expect(isForeignApiNavigation(navigate("cross-site"), "/apix")).toBe(false)
  expect(isForeignApiNavigation({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" }, "/api/fs/read/a.mp4")).toBe(false)
  expect(isForeignApiNavigation({}, "/api/fs/read/a.html")).toBe(false)
})

// The guard through the router, as the server runs it: a tiny route behind the real middleware.
describe("originGuard in the router", () => {
  const status = (request: { host?: string; origin?: string }, config: Record<string, string> = {}) => {
    const route = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter
        yield* router.add("*", "/probe", Effect.succeed(HttpServerResponse.text("ok")))
      }),
    ).pipe(
      Layer.provide(originGuard.pipe(Layer.provide(ServerAuth.Config.layer))),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    )
    const web = HttpRouter.toWebHandler(route, { disableLogger: true })
    const headers = new Headers()
    if (request.host) headers.set("host", request.host)
    if (request.origin) headers.set("origin", request.origin)
    return web.handler(new Request("http://127.0.0.1:4096/probe", { method: "POST", headers })).then((response) => {
      void web.dispose()
      return response.status
    })
  }

  test("the same Host and Origin of a page that is not local do not pass (DNS rebinding)", async () => {
    expect(await status({ host: "evil.example:4096", origin: "http://evil.example:4096" })).toBe(403)
    // a read of the same page carries no Origin
    expect(await status({ host: "evil.example:4096" })).toBe(403)
  })

  test("the local web UI, the app and clients without Origin pass", async () => {
    expect(await status({ host: "127.0.0.1:4096", origin: "http://127.0.0.1:4096" })).toBe(200)
    expect(await status({ host: "localhost:4096", origin: "http://localhost:4096" })).toBe(200)
    expect(await status({ host: "127.0.0.1:4096", origin: "tauri://localhost" })).toBe(200)
    expect(await status({ host: "127.0.0.1:4096" })).toBe(200)
    // in-process calls (the terminal) carry no Host
    expect(await status({})).toBe(200)
  })

  test("a page of another origin does not pass even on a local Host", async () => {
    expect(await status({ host: "127.0.0.1:4096", origin: "https://foreign-site.example" })).toBe(403)
  })

  test("with a password the server keeps the comparison between Host and Origin", async () => {
    const keyed = { OPENCODE_SERVER_PASSWORD: "secret" }
    expect(await status({ host: "192.168.1.20:4096", origin: "http://192.168.1.20:4096" }, keyed)).toBe(200)
    expect(await status({ host: "192.168.1.20:4096", origin: "https://foreign-site.example" }, keyed)).toBe(403)
  })
})
