// The script the phone service puts in the pages of the computer (app/crates/phone/src/loopback.js): the calls a page makes to
// `localhost` or `127.0.0.1` are sent to the phone port, which passes them to the computer. node --test app/scripts/phone-loopback.test.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "crates", "phone", "src", "loopback.js"),
  "utf8",
)
const ORIGIN = "http://192.168.1.20:47097"
const ROUTE = `${ORIGIN}/__mango_loopback`

const toMap = (h) => new Map(h instanceof Map ? h : Object.entries(h ?? {}))

// What a browser's Request does with its arguments that the script depends on: the second argument is read property by
// property (a Request there too), and a body that is a stream needs `duplex: "half"` (and HTTP/2): the script must not use one.
class FakeRequest {
  constructor(input, init) {
    init = init ?? {}
    const base = input instanceof FakeRequest ? input : null
    this.url = String(base ? base.url : input)
    this.method = String(init.method ?? base?.method ?? "GET").toUpperCase()
    this.headers = toMap(init.headers ?? base?.headers)
    this.credentials = init.credentials ?? base?.credentials ?? "same-origin"
    this.mode = init.mode ?? base?.mode ?? "cors"
    this.cache = init.cache ?? base?.cache ?? "default"
    this.redirect = init.redirect ?? base?.redirect ?? "follow"
    this.signal = init.signal ?? base?.signal ?? null
    this.bodyUsed = false
    const given = init.body ?? null
    if (given !== null && given.stream === true && init.duplex !== "half") {
      throw new TypeError("RequestInit: duplex option is required when sending a body.")
    }
    if ((this.method === "GET" || this.method === "HEAD") && (given !== null || (!("body" in init) && base?.stored))) {
      throw new TypeError("Request with GET/HEAD method cannot have body.")
    }
    this.stored = given ?? (base ? base.stored : null)
  }
  get body() {
    return this.stored === null ? null : { stream: true }
  }
  clone() {
    if (this.bodyUsed) throw new TypeError("Request body is already used")
    return new FakeRequest(this)
  }
  arrayBuffer() {
    this.bodyUsed = true
    return Promise.resolve(this.stored)
  }
}

// A page's window with only what the script touches, each of which writes down what it was asked.
function page(origin = ORIGIN) {
  const calls = []
  const requests = []
  const sandbox = {
    URL,
    location: { href: `${origin}/app/index.html`, origin },
    Request: FakeRequest,
    XMLHttpRequest: class {
      open(...args) {
        calls.push(["xhr", ...args])
      }
    },
    WebSocket: class {
      static OPEN = 1
      constructor(...args) {
        calls.push(["websocket", ...args])
      }
    },
    EventSource: class {
      constructor(...args) {
        calls.push(["eventsource", ...args])
      }
    },
    fetch: (...args) => {
      while (args.at(-1) === undefined) args.pop()
      requests.push(args)
      calls.push(["fetch", ...args.map((a) => (typeof a === "object" && a !== null && "url" in a ? a.url : a))])
      return Promise.resolve("native reply")
    },
  }
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)
  return { sandbox, calls, requests }
}

test("a call to localhost or 127.0.0.1, on any port, goes to the phone port", () => {
  const { sandbox, calls } = page()
  sandbox.fetch("http://localhost:3000/api/items?page=2&q=a%20b")
  sandbox.fetch("http://127.0.0.1:8080/x")
  sandbox.fetch("http://localhost/default-port")
  sandbox.fetch(new URL("http://127.0.0.1:5173/from-a-url-object"))
  sandbox.fetch(new sandbox.Request("http://localhost:3000/from-a-request"))
  sandbox.fetch("//localhost:3000/protocol-relative")
  assert.deepEqual(calls, [
    ["fetch", `${ROUTE}/localhost/3000/api/items?page=2&q=a%20b`],
    ["fetch", `${ROUTE}/127.0.0.1/8080/x`],
    ["fetch", `${ROUTE}/localhost/80/default-port`],
    ["fetch", `${ROUTE}/127.0.0.1/5173/from-a-url-object`],
    ["fetch", `${ROUTE}/localhost/3000/from-a-request`],
    ["fetch", `${ROUTE}/localhost/3000/protocol-relative`],
  ])
})

test("fetch keeps what is not an address of the computer, and the other arguments", () => {
  const { sandbox, calls } = page()
  for (const url of [
    "/api",
    "api/relative",
    `${ORIGIN}/its-own-origin`,
    "http://example.com/",
    "https://localhost:3000/",
    "http://localhost.evil.com:3000/",
    "http://127.0.0.2:3000/",
    "http://127.0.0.1.nip.io:3000/",
    "http://[::1]:3000/",
    "http://0.0.0.0:3000/",
    "http://user@localhost.evil.com:3000/",
  ]) {
    sandbox.fetch(url)
  }
  assert.deepEqual(
    calls.map((c) => c[1]),
    ["/api", "api/relative", `${ORIGIN}/its-own-origin`, "http://example.com/", "https://localhost:3000/", "http://localhost.evil.com:3000/", "http://127.0.0.2:3000/", "http://127.0.0.1.nip.io:3000/", "http://[::1]:3000/", "http://0.0.0.0:3000/", "http://user@localhost.evil.com:3000/"],
  )
  calls.length = 0
  sandbox.fetch("http://localhost:3000/save", { method: "POST", body: "x" })
  assert.deepEqual(calls[0].slice(0, 2), ["fetch", `${ROUTE}/localhost/3000/save`])
})

test("a page opened on the computer by the phone's own address keeps its calls to that address", () => {
  const { sandbox, calls } = page("http://localhost:47097")
  sandbox.fetch("http://localhost:47097/api")
  sandbox.fetch("/api")
  sandbox.fetch("http://localhost:3000/api")
  assert.deepEqual(
    calls.map((c) => c[1]),
    ["http://localhost:47097/api", "/api", "http://localhost:47097/__mango_loopback/localhost/3000/api"],
  )
})

test("XMLHttpRequest, WebSocket and EventSource are sent the same way", () => {
  const { sandbox, calls } = page()
  new sandbox.XMLHttpRequest().open("POST", "http://localhost:4000/save", true, "user", "secret")
  new sandbox.XMLHttpRequest().open("GET", "/relative")
  new sandbox.XMLHttpRequest().open("GET", "http://example.com/")
  new sandbox.WebSocket("ws://localhost:3000/live?room=1", ["chat"])
  new sandbox.WebSocket("http://127.0.0.1:3000/also-a-page-address")
  new sandbox.WebSocket("wss://localhost:3000/tls")
  new sandbox.WebSocket("ws://example.com/live")
  new sandbox.EventSource("http://localhost:5000/events", { withCredentials: true })
  new sandbox.EventSource("http://example.com/events")
  assert.deepEqual(calls, [
    ["xhr", "POST", `${ROUTE}/localhost/4000/save`, true, "user", "secret"],
    ["xhr", "GET", "/relative"],
    ["xhr", "GET", "http://example.com/"],
    ["websocket", "ws://192.168.1.20:47097/__mango_loopback/localhost/3000/live?room=1", ["chat"]],
    ["websocket", "ws://192.168.1.20:47097/__mango_loopback/127.0.0.1/3000/also-a-page-address"],
    ["websocket", "wss://localhost:3000/tls"],
    ["websocket", "ws://example.com/live"],
    ["eventsource", `${ROUTE}/localhost/5000/events`, { withCredentials: true }],
    ["eventsource", "http://example.com/events"],
  ])
})

test("the wrapped constructors are still the page's WebSocket and EventSource", () => {
  const { sandbox } = page()
  assert.equal(sandbox.WebSocket.OPEN, 1)
  assert.ok(new sandbox.WebSocket("ws://localhost:1/") instanceof sandbox.WebSocket)
})

test("a Request is sent on with its method, headers, credentials and mode, and a body that is not a stream", async () => {
  const { sandbox, requests } = page()
  const headers = { "content-type": "application/json", "x-token": "t" }
  const original = new sandbox.Request("http://localhost:3000/save", {
    method: "POST",
    headers,
    credentials: "include",
    mode: "cors",
    body: new Uint8Array([1, 2, 3]).buffer,
  })
  assert.equal(await sandbox.fetch(original), "native reply")
  const [sent, init] = requests[0]
  assert.equal(sent.url, `${ROUTE}/localhost/3000/save`)
  assert.equal(sent.method, "POST")
  assert.deepEqual([...sent.headers], Object.entries(headers))
  assert.equal(sent.credentials, "include")
  assert.equal(sent.mode, "cors")
  assert.deepEqual([...new Uint8Array(sent.stored)], [1, 2, 3])
  assert.equal(init, undefined)
  // the page's own Request is still unused: it can read its body, and send it again
  assert.equal(original.bodyUsed, false)

  // a call without a body keeps what it had too, and the second argument of fetch still wins
  const get = new sandbox.Request("http://127.0.0.1:8080/items", { headers: { accept: "text/plain" }, credentials: "omit" })
  await sandbox.fetch(get, { credentials: "same-origin" })
  const [again, override] = requests[1]
  assert.equal(again.url, `${ROUTE}/127.0.0.1/8080/items`)
  assert.equal(again.credentials, "omit")
  assert.deepEqual(override, { credentials: "same-origin" })
  assert.equal(again.method, "GET")
})

test("a Request that is not aimed at the computer, or whose body is gone, goes to fetch as it is", async () => {
  const { sandbox, requests } = page()
  const away = new sandbox.Request("http://example.com/x", { method: "POST", body: new ArrayBuffer(1) })
  await sandbox.fetch(away)
  assert.equal(requests[0][0], away)
  const used = new sandbox.Request("http://localhost:3000/x", { method: "POST", body: new ArrayBuffer(1) })
  used.bodyUsed = true
  await sandbox.fetch(used)
  assert.equal(requests[1][0], used)
})

test("a subclass of the wrapped WebSocket or EventSource is an instance of itself", () => {
  const { sandbox, calls } = page()
  class Mine extends sandbox.WebSocket {}
  class Feed extends sandbox.EventSource {}
  assert.ok(new Mine("ws://localhost:3000/live") instanceof Mine)
  assert.ok(new Feed("http://localhost:5000/events") instanceof Feed)
  assert.deepEqual(calls, [
    ["websocket", "ws://192.168.1.20:47097/__mango_loopback/localhost/3000/live"],
    ["eventsource", `${ROUTE}/localhost/5000/events`],
  ])
})

test("a host that is the name of something every object has is not the computer", () => {
  const { sandbox, calls } = page()
  for (const url of ["http://constructor:3000/", "http://__proto__/x", "http://tostring/y"]) sandbox.fetch(url)
  assert.deepEqual(
    calls.map((c) => c[1]),
    ["http://constructor:3000/", "http://__proto__/x", "http://tostring/y"],
  )
})
