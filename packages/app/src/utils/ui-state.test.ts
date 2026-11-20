import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { blobID, createDraftStore } from "./draft-store"
import type { MangoUiState, MangoUiStateOp, MangoUiStateSnapshot } from "./mango-desktop"
import {
  createUiState as create,
  importOldOrigin,
  mergeServerState,
  openUiState as open,
  portable,
  reloadPage,
  watchUiStateNotices,
  type OldOrigin,
} from "./ui-state"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { uiStorage, useUiStorage } from "./ui-storage"

const SERVER_KEY = "opencode.global.dat:server"

/** The app's side of the bridge, in memory: what `ui_state.rs` keeps on disk. */
function fakeApp(start: Partial<MangoUiStateSnapshot> = {}) {
  const state = { entries: {}, drafts: {}, imported: false, preferred: true, oldOrigin: "http://127.0.0.1:4096", restored: false, old: null, ...start } as MangoUiStateSnapshot
  const superseded: Record<string, string> = {}
  const blobs = new Map<string, ArrayBuffer>()
  const calls: string[] = []
  const applied: MangoUiStateOp[][] = []
  const flushed: [number, boolean][] = []
  const fail = { apply: 0, putBlob: 0, load: false, applyAlways: false }
  const bridge: MangoUiState = {
    load: async () => {
      calls.push("load")
      if (fail.load) throw { code: "unreadable", message: "the file cannot be read" }
      return structuredClone(state)
    },
    apply: async (ops) => {
      calls.push("apply")
      if (fail.apply > 0 || fail.applyAlways) {
        fail.apply -= 1
        throw { code: "io", message: "disk full" }
      }
      // what `ui_state.rs` refuses before it applies anything
      if (ops.some((op) => op.key.length > 4096)) throw { code: "invalid", message: "state key too long" }
      applied.push(ops)
      ops.forEach((op) => {
        const area = op.area === "superseded" ? superseded : state[op.area]
        if (op.value === undefined) delete area[op.key]
        else area[op.key] = op.value
      })
    },
    markImported: async () => {
      calls.push("markImported")
      state.imported = true
    },
    putBlob: async (id, bytes) => {
      calls.push("putBlob")
      if (fail.putBlob > 0) {
        fail.putBlob -= 1
        throw { code: "io", message: "disk full" }
      }
      blobs.set(id, bytes)
    },
    getBlob: async (id) => blobs.get(id) ?? null,
    flushed: async (token, written) => {
      calls.push("flushed")
      flushed.push([token, written])
    },
  }
  return { bridge, state, superseded, blobs, calls, applied, fail, flushed }
}

/** The browser's old storage of the origin, which is only read. */
function oldOrigin(entries: Record<string, string>, documents: Record<string, string> = {}, files: Record<string, Blob> = {}) {
  const reads = { entries: 0, drafts: 0 }
  const origin: OldOrigin = {
    entries: () => {
      reads.entries += 1
      return { ...entries }
    },
    drafts: async () => {
      reads.drafts += 1
      return { documents: { ...documents }, blob: async (id) => files[id] ?? null }
    },
  }
  return { origin, reads }
}

const snapshot = (entries: Record<string, string> = {}, drafts: Record<string, string> = {}) => ({ entries, drafts })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

/** Every state a test makes is closed after it, so that its timers and listeners do not reach the next test. */
const closers: (() => void)[] = []
const createUiState: typeof create = (...args) => {
  const state = create(...args)
  closers.push(state.close)
  return state
}
const openUiState: typeof open = async (...args) => {
  const state = await open(...args)
  closers.push(state.close)
  return state
}

beforeEach(() => {
  useUiStorage(undefined)
  localStorage.clear()
})

afterEach(() => {
  closers.splice(0).forEach((close) => close())
  useUiStorage(undefined)
  localStorage.clear()
})

describe("the interface's state in the app", () => {
  test("it starts from what the app had, and a change is seen at once", () => {
    const app = fakeApp()
    const { storage } = createUiState(app.bridge, snapshot({ a: "1", b: "2" }), { delay: 10_000 })
    expect(storage.length).toBe(2)
    expect(storage.getItem("a")).toBe("1")
    expect(storage.getItem("missing")).toBeNull()
    storage.setItem("c", "3")
    storage.removeItem("a")
    expect([...Array(storage.length).keys()].map((i) => storage.key(i))).toEqual(["b", "c"])
    expect(storage.getItem("a")).toBeNull()
  })

  test("the changes go to the app together, after a short while, the last value of each key", async () => {
    const app = fakeApp()
    const { storage } = createUiState(app.bridge, snapshot(), { delay: 20 })
    storage.setItem("a", "1")
    storage.setItem("a", "2")
    storage.setItem("b", "x")
    storage.removeItem("b")
    expect(app.calls).toEqual([])
    await wait(80)
    expect(app.applied).toEqual([
      [
        { area: "entries", key: "a", value: "2" },
        { area: "entries", key: "b" },
      ],
    ])
    expect(app.state.entries).toEqual({ a: "2" })
  })

  test("a key that was never there is not removed on disk", async () => {
    const app = fakeApp()
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    storage.removeItem("nothing")
    await flush()
    expect(app.calls).toEqual([])
  })

  test("closing the page sends what is waiting", async () => {
    const app = fakeApp()
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    uiStorage.setItem("a", "1")
    expect(app.state.entries).toEqual({})
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    expect(app.state.entries).toEqual({ a: "1" })
  })

  test("changes that arrive while one is being saved are saved after it, in order, also when the first save is slow", async () => {
    const app = fakeApp()
    const apply = app.bridge.apply
    let sends = 0
    app.bridge.apply = async (ops) => {
      if (sends++ === 0) await wait(40)
      return apply(ops)
    }
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    storage.setItem("a", "1")
    const first = flush()
    storage.setItem("a", "2")
    const second = flush()
    await Promise.all([first, second])
    expect(app.applied.map((ops) => ops.map((op) => op.value))).toEqual([["1"], ["2"]])
    expect(app.state.entries).toEqual({ a: "2" })
  })

  test("a save that fails is said, and the same changes go again with the next one", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    app.fail.apply = 1
    storage.setItem("a", "1")
    await flush()
    expect(error).toHaveBeenCalledTimes(1)
    expect(app.state.entries).toEqual({})
    storage.setItem("b", "2")
    await flush()
    expect(app.state.entries).toEqual({ a: "1", b: "2" })
    error.mockRestore()
  })

  test("a retry does not bring back a value that was changed meanwhile", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    app.fail.apply = 1
    storage.setItem("a", "old")
    const failing = flush()
    storage.setItem("a", "new")
    await failing
    await flush()
    expect(app.state.entries).toEqual({ a: "new" })
    error.mockRestore()
  })

  test("the color scheme is also kept in the page's own storage, for the script that paints the page first", () => {
    const app = fakeApp()
    localStorage.setItem("opencode-color-scheme", "light")
    const { storage } = createUiState(app.bridge, snapshot({ "opencode-color-scheme": "dark" }), { delay: 10_000 })
    expect(localStorage.getItem("opencode-color-scheme")).toBe("dark")
    storage.setItem("opencode-color-scheme", "light")
    expect(localStorage.getItem("opencode-color-scheme")).toBe("light")
    storage.setItem("other", "x")
    expect(localStorage.getItem("other")).toBeNull()
    storage.removeItem("opencode-color-scheme")
    expect(localStorage.getItem("opencode-color-scheme")).toBeNull()
  })
})

describe("the drafts in the app", () => {
  test("a draft is kept, read back and removed through the same changes as the rest", async () => {
    const app = fakeApp()
    const { driver, flush } = createUiState(app.bridge, snapshot({}, { "k": '{"a":1}' }), { delay: 10_000 })
    expect(await driver.get("k")).toBe('{"a":1}')
    expect(await driver.get("none")).toBeNull()
    await driver.set("k2", '{"b":2}')
    await driver.remove("k")
    await flush()
    expect(app.state.drafts).toEqual({ k2: '{"b":2}' })
  })

  test("an attachment is named by its hash and comes back with the same bytes", async () => {
    const app = fakeApp()
    const { driver } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    const blob = new Blob([new Uint8Array([1, 2, 3, 250])])
    const id = await driver.putBlob(blob)
    expect(id).toBe(await blobID(blob))
    expect(id).toMatch(/^[0-9a-f]{64}$/)
    expect(new Uint8Array(app.blobs.get(id)!)).toEqual(new Uint8Array([1, 2, 3, 250]))
    expect(new Uint8Array(await (await driver.getBlob(id))!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 250]))
    expect(await driver.getBlob("0".repeat(64))).toBeNull()
  })

  test("a draft with a picture is there after a restart, picture included", async () => {
    const app = fakeApp()
    const before = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    const store = createDraftStore(before.driver)
    const png = "data:image/png;base64,iVBORw0KGgo="
    await store.setItem("scope:draft", JSON.stringify({ prompt: [{ type: "image", dataUrl: png, name: "a.png" }] }))
    await before.flush()

    const after = createUiState(app.bridge, { entries: app.state.entries, drafts: app.state.drafts }, { delay: 10_000 })
    const back = JSON.parse((await createDraftStore(after.driver).getItem("scope:draft"))!)
    expect(back.prompt[0].name).toBe("a.png")
    expect(back.prompt[0].blob.id).toMatch(/^[0-9a-f]{64}$/)
    expect(back.prompt[0].blob.url).toStartWith("blob:")
    expect(app.blobs.size).toBe(1)
  })
})

describe("the state of the persisted stores follows the app's", () => {
  test("what a store saves reaches the app, and the terminal's leftovers are cleaned from it too", async () => {
    mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
    const { PersistTesting } = await import("./persist")
    const { forgetTerminal } = await import("./forget-terminal")
    const app = fakeApp()
    const { storage, flush } = createUiState(
      app.bridge,
      snapshot({ "opencode.global.dat:old:workspace:terminal": "{}" }),
      { delay: 10_000 },
    )
    useUiStorage(storage)

    PersistTesting.localStorageDirect().setItem("opencode.settings.dat:x", '{"y":1}')
    PersistTesting.localStorageWithPrefix("opencode.global.dat").setItem("server", '{"list":[]}')
    expect(forgetTerminal(uiStorage)).toBe(1)
    await flush()
    expect(app.state.entries).toEqual({
      "opencode.settings.dat:x": '{"y":1}',
      "opencode.global.dat:server": '{"list":[]}',
    })
    expect(localStorage.length).toBe(0)
  })
})

describe("the copy of the browser's old storage", () => {
  test("with nothing in the app, everything is copied: keys, drafts and their attachments, and only then it is marked", async () => {
    const app = fakeApp()
    const picture = new Blob([new Uint8Array([9, 9, 9])])
    const id = await blobID(picture)
    const old = oldOrigin(
      { "opencode.global.dat:server": '{"list":[]}', "opencode-color-scheme": "dark", "mango.readyHint.seen": "1" },
      { "default:draft:a": JSON.stringify({ blob: { id } }), "default:draft:b": '{"text":"hi"}' },
      { [id]: picture },
    )
    const merged = await importOldOrigin(app.bridge, snapshot(), old.origin)

    expect(app.state.entries).toEqual({
      "opencode.global.dat:server": '{"list":[]}',
      "opencode-color-scheme": "dark",
      "mango.readyHint.seen": "1",
    })
    expect(Object.keys(app.state.drafts).sort()).toEqual(["default:draft:a", "default:draft:b"])
    expect(new Uint8Array(app.blobs.get(id)!)).toEqual(new Uint8Array([9, 9, 9]))
    expect(app.state.imported).toBe(true)
    expect(app.calls.at(-1)).toBe("markImported")
    // the keys first, then the attachments, then the drafts that name them
    expect(app.calls.indexOf("apply")).toBeLessThan(app.calls.indexOf("putBlob"))
    expect(app.calls.indexOf("putBlob")).toBeLessThan(app.calls.lastIndexOf("apply"))
    expect(merged.entries).toEqual(app.state.entries)
    expect(merged.drafts).toEqual(app.state.drafts)
  })

  test("what the app already has wins; the old values only fill what is missing", async () => {
    const app = fakeApp({ entries: { a: "app", b: "app" }, drafts: { d1: '{"app":1}' } })
    const old = oldOrigin({ a: "old", c: "old" }, { d1: '{"old":1}', d2: '{"old":2}' })
    const merged = await importOldOrigin(app.bridge, snapshot(app.state.entries, app.state.drafts), old.origin)
    expect(app.state.entries).toEqual({ a: "app", b: "app", c: "old" })
    expect(app.state.drafts).toEqual({ d1: '{"app":1}', d2: '{"old":2}' })
    expect(merged.entries).toEqual(app.state.entries)
  })

  test("an old value the app's replaces is kept aside and told, not lost; the same value is not", async () => {
    const app = fakeApp({ entries: { a: "app", same: "x" }, drafts: { d1: '{"app":1}' } })
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    await importOldOrigin(app.bridge, snapshot(app.state.entries, app.state.drafts), oldOrigin({ a: "old", same: "x" }, { d1: '{"old":1}' }).origin)
    expect(app.superseded).toEqual({ "entries/a": "old", "drafts/d1": '{"old":1}' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("a")
    warn.mockRestore()
  })

  test("the open projects of both are kept, one entry for each folder, however the path is written", async () => {
    const mine = JSON.stringify({
      list: [],
      projects: { local: [{ worktree: "C:\\Users\\a\\one", expanded: true }] },
      lastProject: { local: "C:\\Users\\a\\one" },
      recentlyClosed: { local: ["C:\\Users\\a\\closed"] },
    })
    const theirs = JSON.stringify({
      list: [],
      projects: {
        local: [
          { worktree: "C:/Users/a/one/", expanded: false },
          { worktree: "C:\\Users\\a\\two", expanded: false },
        ],
      },
      lastProject: { local: "C:\\Users\\a\\two" },
      recentlyClosed: { local: ["C:/Users/a/closed", "C:\\Users\\a\\other"] },
    })
    const app = fakeApp({ entries: { [SERVER_KEY]: mine } })
    await importOldOrigin(app.bridge, snapshot(app.state.entries), oldOrigin({ [SERVER_KEY]: theirs }).origin)
    const server = JSON.parse(app.state.entries[SERVER_KEY])
    expect(server.projects.local).toEqual([
      { worktree: "C:\\Users\\a\\one", expanded: true },
      { worktree: "C:\\Users\\a\\two", expanded: false },
    ])
    expect(server.lastProject.local).toBe("C:\\Users\\a\\one")
    expect(server.recentlyClosed.local).toEqual(["C:\\Users\\a\\closed", "C:\\Users\\a\\other"])
  })

  test("once marked, the old storage is not read again", async () => {
    const app = fakeApp()
    const old = oldOrigin({ a: "1" })
    await openUiState(app.bridge, old.origin, { delay: 10_000 })
    expect(old.reads).toEqual({ entries: 1, drafts: 1 })
    expect(app.state.imported).toBe(true)

    const again = oldOrigin({ a: "changed", z: "new" })
    await openUiState(app.bridge, again.origin, { delay: 10_000 })
    expect(again.reads).toEqual({ entries: 0, drafts: 0 })
    expect(uiStorage.getItem("a")).toBe("1")
    expect(uiStorage.getItem("z")).toBeNull()
  })

  test("on another port the old storage is not there to copy: nothing is marked, a later start on the preferred port copies it", async () => {
    const app = fakeApp({ preferred: false, entries: { fresh: "1" } })
    const old = oldOrigin({ a: "1" })
    await openUiState(app.bridge, old.origin, { delay: 10_000 })
    expect(old.reads).toEqual({ entries: 0, drafts: 0 })
    expect(app.state.imported).toBe(false)
    expect(uiStorage.getItem("fresh")).toBe("1")

    app.state.preferred = true
    await openUiState(app.bridge, oldOrigin({ a: "1", fresh: "old" }).origin, { delay: 10_000 })
    expect(app.state.imported).toBe(true)
    expect(app.state.entries).toEqual({ fresh: "1", a: "1" })
  })

  test("a copy that fails is said and not marked; the next start does it again and nothing is doubled", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const picture = new Blob([new Uint8Array([7])])
    const id = await blobID(picture)
    const old = () => oldOrigin({ a: "1" }, { "default:draft:p": JSON.stringify({ blob: { id } }) }, { [id]: picture }).origin

    app.fail.putBlob = 1
    await openUiState(app.bridge, old(), { delay: 10_000 })
    expect(error).toHaveBeenCalled()
    expect(app.state.imported).toBe(false)
    expect(app.state.entries).toEqual({ a: "1" })
    expect(uiStorage.getItem("a")).toBe("1")

    await openUiState(app.bridge, old(), { delay: 10_000 })
    expect(app.state.imported).toBe(true)
    expect(app.state.entries).toEqual({ a: "1" })
    expect(Object.keys(app.state.drafts)).toEqual(["default:draft:p"])
    expect(app.blobs.size).toBe(1)
    error.mockRestore()
  })

  test("a draft that points to an attachment the old store lost is skipped and told, the rest of the copy goes on", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const lost = "a".repeat(64)
    const picture = new Blob([new Uint8Array([9])])
    const id = await blobID(picture)
    const old = oldOrigin(
      { k: "v" },
      { gone: JSON.stringify({ blob: { id: lost } }), fine: JSON.stringify({ blob: { id } }), text: "{}" },
      { [id]: picture },
    )
    await importOldOrigin(app.bridge, snapshot(), old.origin)
    expect(app.state.imported).toBe(true)
    expect(Object.keys(app.state.drafts).sort()).toEqual(["fine", "text"])
    expect([...app.blobs.keys()]).toEqual([id])
    expect(error.mock.calls.some((call) => String(call[0]).includes(lost))).toBe(true)
    error.mockRestore()
  })

  test("a draft whose attachment the app could not store is skipped and told, one whose attachment it has is copied", async () => {
    const stored = "b".repeat(64)
    const missing = "c".repeat(64)
    const app = fakeApp({
      preferred: false,
      old: { entries: { k: "v" }, drafts: { ok: JSON.stringify({ blob: { id: stored } }), lost: JSON.stringify({ blob: { id: missing } }), plain: "{}" } },
    })
    app.blobs.set(stored, bytesOf("x"))
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    expect(Object.keys(app.state.drafts).sort()).toEqual(["ok", "plain"])
    expect(app.state.imported).toBe(true)
    expect(error.mock.calls.some((call) => String(call[0]).includes(missing))).toBe(true)
    error.mockRestore()
  })

  test("an app that cannot be asked for an attachment ends the copy unmarked instead of losing the draft", async () => {
    const app = fakeApp({ preferred: false, old: { entries: {}, drafts: { d: JSON.stringify({ blob: { id: "d".repeat(64) } }) } } })
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    app.bridge.getBlob = async () => Promise.reject({ code: "io", message: "disk" })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    expect(app.state.imported).toBe(false)
    expect(app.state.drafts).toEqual({})
    error.mockRestore()
  })
})

describe("opening the state", () => {
  test("a state the app cannot read is an error for the page to show, and the page keeps the browser's storage", async () => {
    const app = fakeApp()
    app.fail.load = true
    await expect(openUiState(app.bridge, oldOrigin({}).origin)).rejects.toMatchObject({ code: "unreadable" })
    localStorage.setItem("kept", "1")
    expect(uiStorage.getItem("kept")).toBe("1")
  })

  test("it hands the page the store of drafts and installs the storage", async () => {
    const app = fakeApp({ entries: { x: "1" }, imported: true })
    const state = await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    expect(uiStorage.getItem("x")).toBe("1")
    await state.draftStore.setItem("k", "{}")
    await state.flush()
    expect(app.state.drafts).toEqual({ k: "{}" })
  })
})

describe("the project lists of two states", () => {
  test("a list that cannot be read gives the other", () => {
    expect(mergeServerState("{not json", '{"list":[]}')).toBe('{"list":[]}')
    expect(mergeServerState('{"list":[]}', "[]")).toBe('{"list":[]}')
  })

  test("the servers added by hand are joined by address", () => {
    const mine = JSON.stringify({ list: ["http://a", { type: "http", http: { url: "http://b" } }] })
    const theirs = JSON.stringify({ list: [{ type: "http", http: { url: "http://a" } }, "http://c"] })
    expect(JSON.parse(mergeServerState(mine, theirs)).list).toEqual(["http://a", { type: "http", http: { url: "http://b" } }, "http://c"])
  })

  test("recently closed folders stay within the history the interface keeps", () => {
    const many = (prefix: string) => Array.from({ length: 12 }, (_, i) => `C:\\${prefix}${i}`)
    const merged = JSON.parse(mergeServerState(JSON.stringify({ recentlyClosed: { local: many("a") } }), JSON.stringify({ recentlyClosed: { local: many("b") } })))
    expect(merged.recentlyClosed.local).toHaveLength(16)
    expect(merged.recentlyClosed.local.slice(0, 12)).toEqual(many("a"))
  })
})

describe("the agent's address in the state", () => {
  const first = "http://127.0.0.1:4096"
  const second = "http://127.0.0.1:50321"

  test("the state is kept without the agent's port, and read with the port of the run", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: first })
    uiStorage.setItem("tabs", JSON.stringify([{ server: first, id: "a" }]))
    uiStorage.setItem(
      "info",
      JSON.stringify({
        [`${first}\n/server/${base64Encode(first)}/session/a`]: { title: "t" },
        [`/server/${base64Encode(first)}9/session/b`]: {},
      }),
    )
    uiStorage.setItem("other", JSON.stringify({ server: "http://127.0.0.1:40960", elsewhere: "http://127.0.0.1:5173" }))
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    expect(Object.values(app.state.entries).join("")).not.toContain("4096\"")
    expect(app.state.entries.tabs).toBe('[{"server":"@agent-origin@","id":"a"}]')

    useUiStorage(undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: second })
    expect(JSON.parse(uiStorage.getItem("tabs")!)).toEqual([{ server: second, id: "a" }])
    expect(Object.keys(JSON.parse(uiStorage.getItem("info")!))).toEqual([
      `${second}\n/server/${base64Encode(second)}/session/a`,
      `/server/${base64Encode(first)}9/session/b`,
    ])
    expect(JSON.parse(uiStorage.getItem("other")!)).toEqual({ server: "http://127.0.0.1:40960", elsewhere: "http://127.0.0.1:5173" })
  })

  test("what the browser kept for the preferred port comes in without it, and the drafts too", async () => {
    const app = fakeApp()
    const old = oldOrigin({ "opencode.global.dat:layout": JSON.stringify({ home: { selection: { server: first, directory: "C:/x" } } }) }, {
      "default:draft:a": JSON.stringify({ link: `${first}/file?path=1` }),
    })
    await openUiState(app.bridge, old.origin, { delay: 10_000, origin: first })
    expect(app.state.entries["opencode.global.dat:layout"]).toContain('"server":"@agent-origin@"')
    // a draft is what the user wrote: the address in it is left as it is
    expect(app.state.drafts["default:draft:a"]).toBe(JSON.stringify({ link: `${first}/file?path=1` }))
    expect(JSON.parse(uiStorage.getItem("opencode.global.dat:layout")!).home.selection.server).toBe(first)
  })
})

describe("what the app gives the page of the old storage", () => {
  const fromApp = (entries: Record<string, string>, drafts: Record<string, string> = {}) => ({ entries, drafts })

  test("it is merged whatever port the page is on, with the attachments the app already stored", async () => {
    const id = "b".repeat(64)
    const app = fakeApp({ preferred: false, old: fromApp({ a: "1" }, { d: JSON.stringify({ blob: { id } }) }) })
    app.blobs.set(id, bytesOf("stored by the app"))
    const browser = oldOrigin({ untouched: "x" })
    await openUiState(app.bridge, browser.origin, { delay: 10_000 })
    expect(browser.reads).toEqual({ entries: 0, drafts: 0 })
    expect(app.state.entries).toEqual({ a: "1" })
    expect(Object.keys(app.state.drafts)).toEqual(["d"])
    expect(app.calls).not.toContain("putBlob")
    expect(app.state.imported).toBe(true)
  })

  test("what the app has already written meanwhile keeps its value and the old one is set aside", async () => {
    const app = fakeApp({
      preferred: false,
      entries: { "opencode.settings.dat:settings.v3": "defaults" },
      old: fromApp({ "opencode.settings.dat:settings.v3": "the user's", other: "kept" }),
    })
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    expect(app.state.entries).toEqual({ "opencode.settings.dat:settings.v3": "defaults", other: "kept" })
    expect(app.superseded).toEqual({ "entries/opencode.settings.dat:settings.v3": "the user's" })
    warn.mockRestore()
  })

  test("nothing is read from the browser when the app has nothing and the page is not on the preferred port", async () => {
    const app = fakeApp({ preferred: false })
    const browser = oldOrigin({ a: "1" })
    await openUiState(app.bridge, browser.origin, { delay: 10_000 })
    expect(browser.reads).toEqual({ entries: 0, drafts: 0 })
    expect(app.state.imported).toBe(false)
  })
})

describe("a copy that meets a draft it cannot read", () => {
  test("the keys are applied first, the unreadable draft or attachment is skipped and told, and the rest is copied and marked", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const good = new Blob([new Uint8Array([1])])
    const goodId = await blobID(good)
    const badId = "c".repeat(64)
    const origin: OldOrigin = {
      entries: () => ({ k: "v" }),
      drafts: async () => ({
        documents: { fine: JSON.stringify({ blob: { id: goodId } }), broken: JSON.stringify({ blob: { id: badId } }) },
        blob: async (id) => {
          if (id === badId) throw new Error("cannot be read")
          return good
        },
      }),
    }
    await importOldOrigin(app.bridge, snapshot(), origin)
    expect(app.state.entries).toEqual({ k: "v" })
    expect(Object.keys(app.state.drafts)).toEqual(["fine"])
    expect(app.state.imported).toBe(true)
    expect(error).toHaveBeenCalled()
    expect(app.calls.indexOf("apply")).toBeLessThan(app.calls.indexOf("putBlob"))
    error.mockRestore()
  })

  test("drafts that cannot be listed leave the keys copied and the copy not marked, and the next start copies the drafts", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const origin: OldOrigin = { entries: () => ({ k: "v" }), drafts: async () => Promise.reject(new Error("no database")) }
    const result = await importOldOrigin(app.bridge, snapshot(), origin)
    expect(app.state.entries).toEqual({ k: "v" })
    expect(app.state.imported).toBe(false)
    expect(result.imported).toBe(false)
    expect(app.calls).not.toContain("markImported")
    await importOldOrigin(app.bridge, snapshot(app.state.entries), oldOrigin({ k: "v" }, { d: "{}" }).origin)
    expect(app.state.imported).toBe(true)
    expect(app.state.drafts).toEqual({ d: "{}" })
    error.mockRestore()
  })
})

describe("the changes reach the app even when the page does not stay open", () => {
  test("a page that changes without pause is still saved within a maximum delay", async () => {
    const app = fakeApp()
    const { storage } = createUiState(app.bridge, snapshot(), { delay: 60, maxWait: 150 })
    const started = Date.now()
    while (Date.now() - started < 400) {
      storage.setItem("a", String(Date.now()))
      await wait(20)
    }
    expect(app.applied.length).toBeGreaterThanOrEqual(2)
    expect(app.state.entries.a).toBeDefined()
  })

  test("the page going to the background sends what is waiting", async () => {
    const app = fakeApp()
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000 })
    uiStorage.setItem("a", "1")
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await wait(20)
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    expect(app.state.entries).toEqual({ a: "1" })
  })

  test("when the app asks, the page sends what it holds and then answers with the app's token", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000 })
    uiStorage.setItem("a", "1")
    window.dispatchEvent(new CustomEvent("mango-ui-state-flush", { detail: 41 }))
    await wait(20)
    expect(app.state.entries).toEqual({ a: "1" })
    expect(app.flushed).toEqual([[41, true]])
    expect(app.calls.indexOf("apply")).toBeLessThan(app.calls.indexOf("flushed"))
  })

  test("the page answers the app even when the write failed, says it did not write, and logs it", async () => {
    const app = fakeApp({ imported: true })
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000, retryAfter: 10_000 })
    app.fail.applyAlways = true
    uiStorage.setItem("a", "1")
    window.dispatchEvent(new CustomEvent("mango-ui-state-flush", { detail: 5 }))
    await wait(20)
    expect(app.flushed).toEqual([[5, false]])
    expect(error.mock.calls.some((call) => String(call[0]).includes("could not be written when the app asked"))).toBe(true)
    error.mockRestore()
  })
})

describe("a state that cannot be written is said to the user and written again by itself", () => {
  test("the notice stays up while the write fails and goes away when it succeeds on a retry", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    const { storage } = createUiState(app.bridge, snapshot(), { delay: 5, retryAfter: 30 })
    app.fail.apply = 2
    storage.setItem("a", "1")
    await wait(25)
    expect(seen).toEqual(["unsaved:true"])
    expect(app.state.entries).toEqual({})
    await wait(150)
    expect(app.state.entries).toEqual({ a: "1" })
    expect(seen).toEqual(["unsaved:true", "unsaved:false"])
    stop()
    error.mockRestore()
  })

  test("a notice that was raised before the interface was there is told to the one that watches later, once", async () => {
    const app = fakeApp({ restored: true, imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    expect(seen).toEqual(["restored:true"])
    stop()
    const again: string[] = []
    watchUiStateNotices((notice, on) => again.push(`${notice}:${on}`))()
    expect(again).toEqual([])
  })

  test("a state restored while the interface watches is told to it", async () => {
    const app = fakeApp({ restored: true, imported: true })
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000 })
    expect(seen).toEqual(["restored:true"])
    stop()
  })

  test("a change the app refuses is left out and told, and does not hold back the others now or later", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    const poison = "k".repeat(5000)
    storage.setItem("before", "1")
    storage.setItem(poison, "x")
    storage.setItem("after", "2")
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({ before: "1", after: "2" })
    storage.setItem("later", "3")
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({ before: "1", after: "2", later: "3" })
    expect(app.applied.flat().filter((op) => op.key === poison)).toEqual([])
    expect(app.calls.filter((call) => call === "apply").length).toBe(5)
    expect(seen).toEqual([])
    expect(error.mock.calls.some((call) => String(call[0]).includes("refused a change"))).toBe(true)
    stop()
    error.mockRestore()
  })

  test("a refused change alone is left out, and an I/O failure after it keeps the rest for the retry", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    storage.setItem("k".repeat(5000), "x")
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({})
    storage.setItem("a", "1")
    app.fail.apply = 1
    expect(await flush()).toBe(false)
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({ a: "1" })
    error.mockRestore()
  })

  test("a batch is cut in groups that stay under the limit of one call", async () => {
    const app = fakeApp()
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    const big = "x".repeat(6 << 20)
    storage.setItem("a", big)
    storage.setItem("b", big)
    storage.setItem("c", big)
    await flush()
    expect(app.applied.map((batch) => batch.map((op) => op.key))).toEqual([["a", "b"], ["c"]])
  })

  test("a failed write does not bring back an old value over a newer one that was written after it", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    storage.setItem("a", "old")
    storage.setItem("gone", "old")
    app.fail.apply = 1
    const first = flush()
    storage.setItem("a", "new")
    storage.removeItem("gone")
    const second = flush()
    await Promise.all([first, second])
    expect(app.state.entries).toEqual({ a: "new" })
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({ a: "new" })
    expect(app.applied.flat().map((op) => `${op.key}=${op.value ?? "-"}`)).toEqual(["a=new", "gone=-"])
    error.mockRestore()
  })

  test("a failed write is sent again when no newer value of its key exists", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    storage.setItem("a", "1")
    storage.setItem("b", "1")
    app.fail.apply = 1
    const first = flush()
    storage.setItem("a", "2")
    await first
    expect(await flush()).toBe(true)
    expect(app.state.entries).toEqual({ a: "2", b: "1" })
    error.mockRestore()
  })

  test("a reload the page starts itself waits for what the state still holds", async () => {
    const app = fakeApp({ imported: true })
    const reload = spyOn(window.location, "reload").mockImplementation(() => undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000 })
    uiStorage.setItem("layout", "new")
    expect(app.state.entries).toEqual({})
    await reloadPage()
    expect(app.state.entries).toEqual({ layout: "new" })
    expect(reload).toHaveBeenCalledTimes(1)
    reload.mockRestore()
  })

  test("a page without the app's state reloads at once", async () => {
    const reload = spyOn(window.location, "reload").mockImplementation(() => undefined)
    await reloadPage()
    expect(reload).toHaveBeenCalledTimes(1)
    reload.mockRestore()
  })
})

describe("only the fields that hold the agent's address are rewritten", () => {
  const first = "http://127.0.0.1:4096"
  const second = "http://127.0.0.1:50321"

  test("what the user wrote stays as written, on disk and on the page", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: first })
    const history = JSON.stringify(["open " + first + "/docs", first, `${first}\nnotes`])
    uiStorage.setItem("opencode.global.dat:prompt-history", history)
    uiStorage.setItem("note", first)
    uiStorage.setItem("not json", `${first} not json`)
    uiStorage.setItem("tabs", JSON.stringify([{ server: first, text: first }]))
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    expect(app.state.entries["opencode.global.dat:prompt-history"]).toBe(history)
    expect(app.state.entries.note).toBe(first)
    expect(app.state.entries["not json"]).toBe(`${first} not json`)
    expect(app.state.entries.tabs).toBe('[{"server":"@agent-origin@","text":"http://127.0.0.1:4096"}]')
  })

  test("a value that is not changed is stored byte for byte", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: first })
    const text = '{ "a" : 1.0 ,\n "big": 12345678901234567890 }'
    uiStorage.setItem("spaced", text)
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    expect(app.state.entries.spaced).toBe(text)
  })

  test("the old storage of the preferred port comes in with the address of the port the page is on", async () => {
    const info = JSON.stringify({ [`${first}\n/server/${base64Encode(first)}/x`]: 1 })
    const app = fakeApp({ preferred: false, old: { entries: { tabs: JSON.stringify([{ server: first, id: "a" }]), info }, drafts: {} } })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: second })
    expect(app.state.entries.tabs).toBe('[{"server":"@agent-origin@","id":"a"}]')
    expect(Object.keys(JSON.parse(app.state.entries.info))).toEqual(["@agent-origin@\n/server/@agent-route@/x"])
    expect(JSON.parse(uiStorage.getItem("tabs")!)).toEqual([{ server: second, id: "a" }])
    expect(Object.keys(JSON.parse(uiStorage.getItem("info")!))).toEqual([`${second}\n/server/${base64Encode(second)}/x`])
  })
})

describe("the strings that are the key of a tab are rewritten wherever they are kept", () => {
  const first = "http://127.0.0.1:4096"
  const second = "http://127.0.0.1:50321"

  test("as a value, in a list, and as a key of a map, but not when they are not a whole key", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: first })
    const key = `${first}\n/server/${base64Encode(first)}/session/s1`
    uiStorage.setItem("recent", JSON.stringify({ key, list: [key, `${first}9\n/server/${base64Encode(first)}9/session/s1`], note: `see ${first}\nnotes` }))
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    const stored = JSON.parse(app.state.entries.recent)
    expect(stored.key).toBe("@agent-origin@\n/server/@agent-route@/session/s1")
    expect(stored.list[0]).toBe(stored.key)
    expect(stored.list[1]).toBe(`${first}9\n/server/${base64Encode(first)}9/session/s1`)
    expect(stored.note).toBe(`see ${first}\nnotes`)

    useUiStorage(undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: second })
    expect(JSON.parse(uiStorage.getItem("recent")!).key).toBe(`${second}\n/server/${base64Encode(second)}/session/s1`)
  })
})

describe("the store of the interface, in the details", () => {
  test("the keys follow the changes made after they were first listed", () => {
    const app = fakeApp()
    const { storage } = createUiState(app.bridge, snapshot({ a: "1" }), { delay: 10_000 })
    expect(storage.key(0)).toBe("a")
    storage.setItem("b", "2")
    expect(storage.key(1)).toBe("b")
    storage.removeItem("a")
    expect([storage.key(0), storage.key(1)]).toEqual(["b", null])
  })

  test("a value that is not a string is kept as its text", async () => {
    const app = fakeApp()
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000 })
    storage.setItem("n", 5 as unknown as string)
    expect(storage.getItem("n")).toBe("5")
    await flush()
    expect(app.state.entries).toEqual({ n: "5" })
  })

  test("a draft that is removed is gone for the page and for the app", async () => {
    const app = fakeApp({ drafts: { k: "{}", keep: "{}" } })
    const { driver, flush } = createUiState(app.bridge, snapshot({}, { k: "{}", keep: "{}" }), { delay: 10_000 })
    await driver.remove("k")
    expect(await driver.get("k")).toBeNull()
    await flush()
    expect(Object.keys(app.state.drafts)).toEqual(["keep"])
  })

  test("the maximum wait counts from the first change after a save, not from an older one", async () => {
    const app = fakeApp()
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 250, maxWait: 80 })
    storage.setItem("a", "1")
    await flush()
    await wait(120)
    storage.setItem("b", "2")
    await wait(30)
    expect(app.applied.length).toBe(1)
    await wait(150)
    expect(app.applied.length).toBe(2)
  })

  test("closing the store stops its timers and its notice, and a save that fails afterwards is not tried again", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))

    const waiting = fakeApp()
    const idle = createUiState(waiting.bridge, snapshot(), { delay: 30 })
    idle.storage.setItem("a", "1")
    idle.close()
    await wait(80)
    expect(waiting.calls).toEqual([])

    const retrying = fakeApp()
    retrying.fail.applyAlways = true
    const trying = createUiState(retrying.bridge, snapshot(), { delay: 5, retryAfter: 30 })
    trying.storage.setItem("a", "1")
    await wait(20)
    expect(seen).toEqual(["unsaved:true"])
    trying.close()
    expect(seen).toEqual(["unsaved:true", "unsaved:false"])
    await wait(100)
    expect(retrying.calls).toEqual(["apply"])

    const inFlight = fakeApp()
    inFlight.fail.applyAlways = true
    const slow = inFlight.bridge.apply
    inFlight.bridge.apply = async (ops) => {
      await wait(30)
      return slow(ops)
    }
    const leaving = createUiState(inFlight.bridge, snapshot(), { delay: 10_000, retryAfter: 20 })
    leaving.storage.setItem("a", "1")
    const sending = leaving.flush()
    leaving.close()
    await sending
    await wait(100)
    expect(inFlight.calls).toEqual(["apply"])
    stop()
    error.mockRestore()
  })

  test("a state that is created takes back a notice the one before left up", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const broken = fakeApp()
    broken.fail.applyAlways = true
    const before = createUiState(broken.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    before.storage.setItem("a", "1")
    await before.flush()
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    expect(seen).toEqual(["unsaved:true"])
    createUiState(fakeApp().bridge, snapshot(), { delay: 10_000 })
    expect(seen).toEqual(["unsaved:true", "unsaved:false"])
    stop()
    error.mockRestore()
  })

  test("a watcher that has stopped is told nothing more", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    stop()
    const app = fakeApp()
    app.fail.applyAlways = true
    const { storage, flush } = createUiState(app.bridge, snapshot(), { delay: 10_000, retryAfter: 10_000 })
    storage.setItem("a", "1")
    await flush()
    expect(seen).toEqual([])
    error.mockRestore()
  })
})

describe("opening the state, in the details", () => {
  test("a page that is in the foreground does not send its changes when its visibility is told", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000 })
    uiStorage.setItem("a", "1")
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    await wait(20)
    expect(app.calls).toEqual(["load"])
  })

  test("what it set up is taken down by closing: no listener, no notice", async () => {
    const app = fakeApp({ restored: true, imported: true })
    const state = await open(app.bridge, oldOrigin({}).origin, { delay: 10_000, maxWait: 10_000 })
    const seen: string[] = []
    const stop = watchUiStateNotices((notice, on) => seen.push(`${notice}:${on}`))
    uiStorage.setItem("a", "1")
    state.close()
    expect(seen).toEqual(["restored:true"])
    window.dispatchEvent(new Event("pagehide"))
    window.dispatchEvent(new CustomEvent("mango-ui-state-flush", { detail: 3 }))
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    await wait(30)
    expect(app.calls).toEqual(["load"])
    stop()
  })

  test("a state that cannot be read gives no empty one in its place", async () => {
    const app = fakeApp()
    app.fail.load = true
    await expect(open(app.bridge, oldOrigin({}).origin)).rejects.toMatchObject({ code: "unreadable" })
    expect(app.calls).toEqual(["load"])
  })
})

describe("the agent's address in the state, in the details", () => {
  const first = "http://127.0.0.1:4096"
  const second = "http://127.0.0.1:50321"
  const route = `/server/${base64Encode(first)}/session/s1`

  test("a route to the agent is rewritten also when it is the whole string, and a list item that is only the address is not", async () => {
    const app = fakeApp({ imported: true })
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: first })
    uiStorage.setItem("last", JSON.stringify({ href: route, hrefs: [route], servers: [first], server: first }))
    window.dispatchEvent(new Event("pagehide"))
    await wait(20)
    expect(JSON.parse(app.state.entries.last)).toEqual({ href: "/server/@agent-route@/session/s1", hrefs: ["/server/@agent-route@/session/s1"], servers: [first], server: "@agent-origin@" })
    useUiStorage(undefined)
    await openUiState(app.bridge, oldOrigin({}).origin, { delay: 10_000, origin: second })
    expect(JSON.parse(uiStorage.getItem("last")!).href).toBe(`/server/${base64Encode(second)}/session/s1`)
  })

  test("the drafts and the attachments go to the app as they are, and the rest of the bridge is the app's", async () => {
    const app = fakeApp()
    const bridge = portable(app.bridge, first)
    const entry = JSON.stringify({ server: first })
    await bridge.apply([
      { area: "drafts", key: "d", value: entry },
      { area: "entries", key: "e", value: entry },
    ])
    expect(app.state.drafts.d).toBe(entry)
    expect(app.state.entries.e).toBe('{"server":"@agent-origin@"}')
    await bridge.putBlob("x", bytesOf("bytes"))
    expect(app.blobs.has("x")).toBe(true)
    expect(await bridge.load()).toMatchObject({ imported: false })
  })
})

describe("the copy of the browser's old storage, in the details", () => {
  test("a copy cut short at the keys is not marked and the next start does it again", async () => {
    const app = fakeApp()
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    app.fail.apply = 1
    const merged = await importOldOrigin(app.bridge, snapshot(), oldOrigin({ a: "1" }, { d: "{}" }).origin)
    expect(merged.imported).toBe(false)
    expect(app.state.imported).toBe(false)
    expect(app.state.drafts).toEqual({})
    error.mockRestore()
  })

  test("the keys that come out the same are not sent again", async () => {
    const app = fakeApp({ entries: { a: "1" } })
    await importOldOrigin(app.bridge, snapshot({ a: "1" }), oldOrigin({ a: "1" }).origin)
    expect(app.calls).toEqual(["markImported"])
  })

  test("the copy is marked only after the drafts are in the app, and the old origin is let go when it is done", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined)
    let closed = 0
    const origin = (): OldOrigin => ({
      entries: () => ({ k: "v" }),
      drafts: async () => ({ documents: { d: "{}" }, blob: async () => null, close: () => void closed++ }),
    })
    const app = fakeApp()
    const order: string[] = []
    const apply = app.bridge.apply
    app.bridge.apply = async (ops) => {
      order.push(ops[0].area)
      await wait(10)
      return apply(ops)
    }
    const markImported = app.bridge.markImported
    app.bridge.markImported = async () => {
      order.push("mark")
      return markImported()
    }
    await importOldOrigin(app.bridge, snapshot(), origin())
    expect(order).toEqual(["entries", "drafts", "mark"])
    expect(closed).toBe(1)

    const failing = fakeApp()
    failing.bridge.markImported = async () => {
      throw { code: "io", message: "disk full" }
    }
    const merged = await importOldOrigin(failing.bridge, snapshot(), origin())
    expect(merged.imported).toBe(false)
    expect(closed).toBe(2)
    error.mockRestore()
  })

  test("the attachments a draft names are found wherever it names them, and only the ones that are hashes", async () => {
    const app = fakeApp()
    const files = ["1", "2", "3"].map((text) => new Blob([text]))
    const ids = await Promise.all(files.map(blobID))
    const document = JSON.stringify({
      prompt: [{ blob: { id: ids[0] } }, { nested: { deeper: [{ blob: { id: ids[1] } }] } }],
      blob: { id: ids[2] },
      odd: { blob: { id: "not-a-hash" } },
    })
    await importOldOrigin(app.bridge, snapshot(), oldOrigin({}, { d: document }, { [ids[0]]: files[0], [ids[1]]: files[1], [ids[2]]: files[2] }).origin)
    expect([...app.blobs.keys()].sort()).toEqual([...ids].sort())

    const other = fakeApp()
    await importOldOrigin(other.bridge, snapshot(), oldOrigin({}, { d: "{not json", e: '{"blob":{"id":"zz"}}' }, { zz: new Blob(["x"]) }).origin)
    expect(other.blobs.size).toBe(0)
    expect(Object.keys(other.state.drafts).sort()).toEqual(["d", "e"])
  })

  test("the attachments are not read for a draft the app has, and not at all when the app already stored them", async () => {
    const app = fakeApp({ drafts: { d: '{"app":1}' } })
    const picture = new Blob([new Uint8Array([4])])
    const id = await blobID(picture)
    const reads: string[] = []
    const read = async (name: string) => (reads.push(name), picture)
    await importOldOrigin(app.bridge, snapshot({}, app.state.drafts), {
      entries: () => ({}),
      drafts: async () => ({ documents: { d: JSON.stringify({ blob: { id } }) }, blob: read }),
    })
    expect(reads).toEqual([])

    app.blobs.set(id, bytesOf("stored by the app"))
    await importOldOrigin(app.bridge, snapshot({}, app.state.drafts), {
      entries: () => ({}),
      drafts: async () => ({ documents: { e: JSON.stringify({ blob: { id } }) }, blob: read, inApp: true }),
    })
    expect(reads).toEqual([])
    expect(app.calls).not.toContain("putBlob")
    expect(Object.keys(app.state.drafts).sort()).toEqual(["d", "e"])
  })
})

describe("the project lists of two states, in the details", () => {
  const project = (worktree: string) => ({ worktree })

  test("the first one's values win, field by field, and the second one's fields are kept when the first has none", () => {
    const merged = JSON.parse(mergeServerState(JSON.stringify({ shared: "mine", list: [] }), JSON.stringify({ shared: "theirs", only: "theirs", list: [] })))
    expect(merged.shared).toBe("mine")
    expect(merged.only).toBe("theirs")
  })

  test("scopes that only the second one has are kept, and an item twice in the second one comes once", () => {
    const mine = JSON.stringify({ projects: { local: [project("C:\\a")] }, recentlyClosed: {} })
    const theirs = JSON.stringify({
      projects: { local: [project("C:/b"), project("C:\\b\\")], remote: [project("/srv/x")] },
      recentlyClosed: { remote: ["/srv/y"] },
      list: ["http://x", "http://x"],
    })
    const merged = JSON.parse(mergeServerState(mine, theirs))
    expect(merged.projects.local.map((item: { worktree: string }) => item.worktree)).toEqual(["C:\\a", "C:/b"])
    expect(merged.projects.remote).toEqual([project("/srv/x")])
    expect(merged.recentlyClosed.remote).toEqual(["/srv/y"])
    expect(merged.list).toEqual(["http://x"])
  })

  test("what has no address or no folder is not joined, and a server given as an object by its http address is found", () => {
    const mine = JSON.stringify({ list: [{ type: "http", http: { url: "http://a" } }], projects: { local: [{ name: "no folder" }] } })
    const theirs = JSON.stringify({ list: [{ type: "ssh" }, { type: "http", http: { url: "http://a" } }, { type: "http", http: { url: "http://c" } }, { url: "http://b" }], projects: { local: [{ name: "also none" }] } })
    const merged = JSON.parse(mergeServerState(mine, theirs))
    expect(merged.list).toEqual([{ type: "http", http: { url: "http://a" } }, { type: "http", http: { url: "http://c" } }, { url: "http://b" }])
    expect(merged.projects.local).toEqual([{ name: "no folder" }])
  })
})
