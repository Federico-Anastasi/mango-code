// The interface's state inside the Mango Code window. The app keeps it on disk (`ui_state.rs`); the page works on a copy
// in memory that it reads before it draws, sends its changes a moment after they happen (and at the latest after a
// maximum wait, when the page goes to the background, when the app asks, and when the page closes), and installs as the
// storage the rest of the interface uses (`ui-storage.ts`). A normal browser and the phone do not come here: they keep
// their `localStorage`.
//
// The browser's storage of the origin the page is served from, the agent's address, held this state in older
// releases. It is copied to the app's state once (`importOldOrigin`), from what the app read of that origin
// (`old` in the snapshot) or, where the page is served from that origin, from the browser's storage itself; the browser's
// data is read, never changed.

import { base64Encode } from "@opencode-ai/core/util/encode"
import { blobID, createDraftStore, readBrowserDrafts, type DraftDriver } from "@/utils/draft-store"
import type { MangoUiState, MangoUiStateOp, MangoUiStateSnapshot } from "@/utils/mango-desktop"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { pathKey } from "@/utils/path-key"
import { useUiStorage, type UiStorage } from "@/utils/ui-storage"

const SERVER_KEY = "opencode.global.dat:server"
/** The script that paints the page before anything loads reads this key synchronously, so the page's own storage keeps a copy. */
const MIRRORED_KEYS = ["opencode-color-scheme"]
/** The same history the interface keeps of the projects it closed (`context/server.tsx`). */
const RECENTLY_CLOSED_LIMIT = 16
const DELAY = 250
const MAX_WAIT = 2000
const RETRY_AFTER = 3000
/** A batch of changes stays well under what the app takes in one call (`ui_state.rs`); counted in UTF-16 units, which are at most 3 bytes each. */
const BATCH_UNITS = 16 << 20

type Entries = Record<string, string>
type State = { entries: Entries; drafts: Entries }

/**
 * What the user is told about the state: it could not be written (`unsaved`, up until a retry succeeds), or it was read from
 * the backup copy (`restored`, told once, to whoever watches first).
 */
export type UiStateNotice = "unsaved" | "restored"

const active = new Set<UiStateNotice>()
const watchers = new Set<(notice: UiStateNotice, on: boolean) => void>()
let restoredWaiting = false

function setNotice(notice: UiStateNotice, on: boolean) {
  if (on === active.has(notice)) return
  if (on) active.add(notice)
  else active.delete(notice)
  watchers.forEach((watcher) => watcher(notice, on))
}

function tellRestored() {
  if (!watchers.size) restoredWaiting = true
  else watchers.forEach((watcher) => watcher("restored", true))
}

/** Calls `watcher` for the notices that are up now and for each change; the interface shows them (`ui-state-notice.tsx`). */
export function watchUiStateNotices(watcher: (notice: UiStateNotice, on: boolean) => void) {
  active.forEach((notice) => watcher(notice, true))
  watchers.add(watcher)
  if (restoredWaiting) {
    restoredWaiting = false
    watcher("restored", true)
  }
  return () => void watchers.delete(watcher)
}

/** What the browser kept for this origin. */
export type OldOrigin = {
  entries(): Entries
  drafts(): Promise<{
    documents: Entries
    blob(id: string): Promise<Blob | null>
    close?(): void
    /** The attachments are already in the app's folder: they are not read again. */
    inApp?: boolean
  }>
}

export const browserOrigin = (): OldOrigin => ({
  entries: () =>
    Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).flatMap((key) => {
        const value = key === null ? null : localStorage.getItem(key)
        return key === null || value === null ? [] : [[key, value]]
      }),
    ),
  drafts: readBrowserDrafts,
})

/** What the app read of the old origin, as an origin to copy from. */
const appOrigin = (old: NonNullable<MangoUiStateSnapshot["old"]>): OldOrigin => ({
  entries: () => old.entries,
  drafts: async () => ({ documents: old.drafts, blob: async () => null, inApp: true }),
})

export function createUiState(
  bridge: MangoUiState,
  snapshot: State,
  options: { delay?: number; maxWait?: number; retryAfter?: number } = {},
) {
  const delay = options.delay ?? DELAY
  const maxWait = options.maxWait ?? MAX_WAIT
  const retryAfter = options.retryAfter ?? RETRY_AFTER
  const entries = new Map(Object.entries(snapshot.entries))
  const drafts = new Map(Object.entries(snapshot.drafts))
  /** The last change of each key not sent yet; `latest` has the number of the last one of each key that is not written. */
  const pending = new Map<string, Change>()
  const latest = new Map<string, number>()
  let changes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let oldest: number | undefined
  let sending = Promise.resolve()
  let failed = false
  let keys: string[] | undefined
  let closed = false
  setNotice("unsaved", false)

  const queue = (op: MangoUiStateOp) => {
    const id = changeId(op)
    changes += 1
    latest.set(id, changes)
    pending.delete(id)
    pending.set(id, { op, number: changes })
    const now = Date.now()
    oldest ??= now
    clearTimeout(timer)
    timer = setTimeout(() => void flush(), Math.max(0, Math.min(delay, oldest + maxWait - now)))
  }

  const written = (change: Change) => {
    if (latest.get(changeId(change.op)) === change.number) latest.delete(changeId(change.op))
  }

  /**
   * Sends the changes in batches. A batch the app refuses as invalid is sent again one change at a time, and the one that
   * is refused alone is left out and told: it would be refused every time, and with it in a batch nothing would be saved. Any
   * other failure may pass (a disk that is full, busy): the changes that were not written wait for the next try, unless a
   * newer change of the same key exists, which is the one that counts.
   */
  const write = async (taken: Change[]) => {
    const unwritten: Change[] = []
    const work = batches(taken)
    for (let batch = work.shift(); batch; batch = work.shift()) {
      if (unwritten.length) {
        unwritten.push(...batch)
        continue
      }
      try {
        await bridge.apply(batch.map((change) => change.op))
        batch.forEach(written)
      } catch (cause) {
        if (mangoDesktopError(cause).code !== "invalid") {
          console.error("the interface's state was not saved", cause)
          unwritten.push(...batch)
        } else if (batch.length > 1) {
          work.unshift(...batch.map((change) => [change]))
        } else {
          console.error(`the interface's state refused a change, which is left out: ${batch[0].op.area} ${batch[0].op.key.slice(0, 80)}`, cause)
          written(batch[0])
        }
      }
    }
    unwritten.forEach((change) => {
      const id = changeId(change.op)
      if (latest.get(id) === change.number && !pending.has(id)) pending.set(id, change)
    })
    failed = unwritten.length > 0
    setNotice("unsaved", failed)
    if (failed && !closed) retry = setTimeout(() => void flush(), retryAfter)
  }

  /** Sends what is waiting; says whether the last send wrote everything it had. */
  const flush = () => {
    clearTimeout(timer)
    clearTimeout(retry)
    oldest = undefined
    const taken = [...pending.values()]
    pending.clear()
    if (taken.length) sending = sending.then(() => write(taken))
    return sending.then(() => !failed)
  }

  const mirror = (key: string, value: string | null) => {
    if (!MIRRORED_KEYS.includes(key)) return
    try {
      if (value === null) localStorage.removeItem(key)
      else if (localStorage.getItem(key) !== value) localStorage.setItem(key, value)
    } catch {}
  }
  MIRRORED_KEYS.forEach((key) => {
    const value = entries.get(key)
    if (value !== undefined) mirror(key, value)
  })

  const storage: UiStorage = {
    get length() {
      return entries.size
    },
    key: (index) => (keys ??= [...entries.keys()])[index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      const text = String(value)
      if (!entries.has(key)) keys = undefined
      entries.set(key, text)
      queue({ area: "entries", key, value: text })
      mirror(key, text)
    },
    removeItem: (key) => {
      if (!entries.delete(key)) return
      keys = undefined
      queue({ area: "entries", key })
      mirror(key, null)
    },
  }

  const driver: DraftDriver = {
    get: async (key) => drafts.get(key) ?? null,
    set: async (key, value) => {
      drafts.set(key, value)
      queue({ area: "drafts", key, value })
    },
    remove: async (key) => {
      drafts.delete(key)
      queue({ area: "drafts", key })
    },
    putBlob: async (blob) => {
      const id = await blobID(blob)
      await bridge.putBlob(id, await blob.arrayBuffer())
      return id
    },
    getBlob: async (id) => {
      const bytes = await bridge.getBlob(id)
      return bytes ? new Blob([bytes]) : null
    },
  }

  /** Stops the timers and takes back its notice: the state is not used any more. */
  const close = () => {
    closed = true
    clearTimeout(timer)
    clearTimeout(retry)
    setNotice("unsaved", false)
  }

  return { storage, driver, flush, close }
}

type Change = { op: MangoUiStateOp; number: number }

const changeId = (op: MangoUiStateOp) => `${op.area}\0${op.key}`

/** The changes in groups that fit in one call to the app, in order; a change bigger than a group is a group of its own. */
function batches(changes: Change[]) {
  const groups: Change[][] = []
  let size = 0
  changes.forEach((change) => {
    const units = change.op.key.length + (change.op.value?.length ?? 0)
    if (!groups.length || size + units > BATCH_UNITS) {
      groups.push([])
      size = 0
    }
    groups[groups.length - 1].push(change)
    size += units
  })
  return groups
}

let current: ReturnType<typeof createUiState> | undefined

/**
 * Reloads the page after the state it holds is written: the changes wait up to a moment before they go to the app, and a reload
 * the page starts itself (a setting that takes a new start) would lose them. A page that does not keep its state in the app
 * (a normal browser) reloads at once.
 */
export async function reloadPage() {
  // The setting that asked for the reload is stored in a task of its own.
  await new Promise<void>((done) => setTimeout(done))
  if (!(await current?.flush() ?? true)) console.error("the interface's state could not be written before the page reloaded")
  window.location.reload()
}

/**
 * Reads the state from the app (rejecting with the app's error when it cannot), copies the browser's old storage if it is
 * the time, and installs the state as the interface's storage. The caller shows the error and does not draw the interface.
 */
export async function openUiState(
  app: MangoUiState,
  browser: OldOrigin,
  options: { delay?: number; maxWait?: number; retryAfter?: number; origin?: string } = {},
) {
  const origin = options.origin ?? location.origin
  const snapshot = await app.load()
  if (snapshot.restored) tellRestored()
  // The copy works on the state as the app keeps it (the agent's address left out), from an origin whose own address is left out too.
  const old = snapshot.imported ? undefined : snapshot.old ? appOrigin(snapshot.old) : snapshot.preferred ? browser : undefined
  const stored = old ? { ...snapshot, ...(await importOldOrigin(app, snapshot, withoutAddress(old, snapshot.oldOrigin))) } : snapshot
  const coder = addressCoder(origin)
  const bridge = portable(app, origin)
  const state = createUiState(bridge, { entries: coder.entries(stored.entries, "decode"), drafts: stored.drafts }, options)
  useUiStorage(state.storage)
  const flushNow = () => void state.flush()
  current = state
  const hidden = () => {
    if (document.visibilityState === "hidden") flushNow()
  }
  // The app is about to close the page or the window: it waits for this answer, and is told whether it was written.
  const asked = (event: Event) => {
    const token = (event as CustomEvent<number>).detail
    void state.flush().then((written) => {
      if (!written) console.error("the interface's state could not be written when the app asked for it")
      return app.flushed(token, written).catch(() => undefined)
    })
  }
  window.addEventListener("pagehide", flushNow)
  document.addEventListener("visibilitychange", hidden)
  window.addEventListener("mango-ui-state-flush", asked)
  const close = () => {
    window.removeEventListener("pagehide", flushNow)
    document.removeEventListener("visibilitychange", hidden)
    window.removeEventListener("mango-ui-state-flush", asked)
    if (current === state) current = undefined
    state.close()
  }
  return { draftStore: createDraftStore(state.driver), flush: state.flush, close }
}

/** The stores whose strings are what the user wrote (the history of prompts, the messages waiting): never rewritten. */
const USER_TEXT = ["prompt-history", "prompt-history-shell", "mango.pending.v1"]
const AGENT = "@agent-origin@"
/** The same address as the routes write it (`/server/<address>/session/<id>`). */
const AGENT_ROUTE = "@agent-route@"

/**
 * Writes the agent's own address in or out of the interface's state. Some of what the interface keeps names the server it
 * belongs to by its address (the open tabs, the project selected on the Home), and the address of the agent has its port:
 * on disk the agent is a placeholder instead, so the state is the same whatever port the agent had when it was saved.
 * Only the fields that hold the address are changed: a property called `server` whose value is the address, the keys of a
 * map that are the address, and the strings that begin with the address and a line break (`<address>\n<route>`, the key of
 * a tab) or are a route to it (`/server/<address in base64>/...`). Text of the user that happens to contain the address
 * stays as it is.
 */
export function addressCoder(origin: string) {
  const route = base64Encode(origin)
  const identity = origin === ""
  const swap = (text: string, from: string, to: string, boundary: "\n" | "/", alone: boolean) =>
    (alone && text === from) || text.startsWith(from + boundary) ? to + text.slice(from.length) : undefined
  const forms = {
    encode: { address: [origin, AGENT], route: [`/server/${route}`, `/server/${AGENT_ROUTE}`] },
    decode: { address: [AGENT, origin], route: [`/server/${AGENT_ROUTE}`, `/server/${route}`] },
  } as const
  /** `alone`: the address by itself counts (a key of a map, the value of `server`), otherwise only as the start of a longer string. */
  const convert = (text: string, direction: "encode" | "decode", alone: boolean) => {
    if (identity) return text
    const { address, route: path } = forms[direction]
    const inRoute = (rest: string) => swap(rest, path[0], path[1], "/", true) ?? rest
    const head = swap(text, address[0], address[1], "\n", alone)
    if (head !== undefined) {
      const split = head.indexOf("\n")
      return split === -1 ? head : head.slice(0, split + 1) + inRoute(head.slice(split + 1))
    }
    return inRoute(text)
  }
  const walk = (value: unknown, direction: "encode" | "decode", alone = false): unknown => {
    if (typeof value === "string") return convert(value, direction, alone)
    if (Array.isArray(value)) return value.map((item) => walk(item, direction))
    if (!isRecord(value)) return value
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [convert(name, direction, true), walk(item, direction, name === "server")]))
  }
  const text = (name: string, value: string, direction: "encode" | "decode") => {
    if (identity || USER_TEXT.some((stored) => name.endsWith(`:${stored}`))) return value
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed !== "object" || parsed === null) return value
      const converted = JSON.stringify(walk(parsed, direction))
      return JSON.stringify(parsed) === converted ? value : converted
    } catch {
      return value
    }
  }
  return {
    entries: (entries: Entries, direction: "encode" | "decode") =>
      Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, text(name, value, direction)])),
    value: text,
  }
}

/** An old origin with its own address left out of what it gives. */
function withoutAddress(old: OldOrigin, origin: string): OldOrigin {
  const coder = addressCoder(origin)
  return { ...old, entries: () => coder.entries(old.entries(), "encode") }
}

/**
 * The bridge as the page uses it: the agent's address is the page's own on this side and a placeholder on the app's, in the
 * changes the page sends (the drafts and the attachments go as they are).
 */
export function portable(bridge: MangoUiState, origin: string): MangoUiState {
  const coder = addressCoder(origin)
  return {
    ...bridge,
    apply: (ops) =>
      bridge.apply(ops.map((op) => (op.area === "entries" && op.value !== undefined ? { ...op, value: coder.value(op.key, op.value, "encode") } : op))),
  }
}

/**
 * Copies what the browser kept to the app's state. The keys come first: the app's own values win, the old ones only fill
 * what is missing, the projects lists are joined (`mergeServerState`), and an old value that the app's replaces is set aside
 * in the app (`superseded`) and told. Then the drafts: a draft whose attachment is not there or cannot be read is skipped and
 * told, the rest is copied. The copy is marked done only when everything was read and written; one cut short by a drafts
 * list that cannot be read, or by a write that fails, is made again at the next start and finds the same result. Gives the
 * state as it is now, and whether the copy is done.
 */
export async function importOldOrigin(bridge: MangoUiState, snapshot: State, old: OldOrigin): Promise<State & { imported: boolean }> {
  const entries = { ...snapshot.entries }
  const drafts = { ...snapshot.drafts }
  const keyOps: MangoUiStateOp[] = []
  const next: Entries = {}
  const replaced: string[] = []

  try {
    Object.entries(old.entries()).forEach(([key, value]) => {
      const mine = entries[key]
      if (mine === undefined) {
        next[key] = value
      } else if (key === SERVER_KEY) {
        next[key] = mergeServerState(mine, value)
      } else if (mine !== value) {
        replaced.push(key)
        keyOps.push({ area: "superseded", key: `entries/${key}`, value })
      }
      if (key in next && next[key] !== mine) keyOps.push({ area: "entries", key, value: next[key] })
    })
    if (keyOps.length) await bridge.apply(keyOps)
    Object.assign(entries, next)
  } catch (cause) {
    console.error("the browser's old storage was not copied; the next start tries again", cause)
    return { entries, drafts, imported: false }
  }
  if (replaced.length) console.warn("the browser's old storage had other values for keys the app already had; they were set aside:", replaced)

  const kept = await old.drafts().catch((cause: unknown) => {
    console.error("the browser's old drafts were not read; the next start tries again", cause)
  })
  if (!kept) return { entries, drafts, imported: false }
  try {
    const draftOps: MangoUiStateOp[] = []
    for (const [key, document] of Object.entries(kept.documents)) {
      if (key in drafts) {
        if (drafts[key] !== document) draftOps.push({ area: "superseded", key: `drafts/${key}`, value: document })
        continue
      }
      const files: [string, ArrayBuffer][] = []
      let lost: string | undefined
      for (const id of blobIds(document)) {
        if (kept.inApp) {
          // Already in the app's folder, or not: the app failing to answer is not a lost attachment, and ends the copy.
          if (!(await bridge.getBlob(id))) lost = id
        } else {
          try {
            const blob = await kept.blob(id)
            if (blob) files.push([id, await blob.arrayBuffer()])
            else lost = id
          } catch (cause) {
            console.error(`its attachment ${id} cannot be read`, cause)
            lost = id
          }
        }
        if (lost) break
      }
      if (lost) {
        console.error(`a draft of the browser's old storage was not copied: its attachment ${lost} is not there or cannot be read`)
        continue
      }
      for (const [id, bytes] of files) await bridge.putBlob(id, bytes)
      draftOps.push({ area: "drafts", key, value: document })
    }
    if (draftOps.length) await bridge.apply(draftOps)
    draftOps.forEach((op) => {
      if (op.area === "drafts" && op.value !== undefined) drafts[op.key] = op.value
    })
    await bridge.markImported()
  } catch (cause) {
    console.error("the browser's old drafts were not copied; the next start tries again", cause)
    return { entries, drafts, imported: false }
  } finally {
    kept.close?.()
  }
  return { entries, drafts, imported: true }
}

function blobIds(document: string) {
  const ids = new Set<string>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    const item = value as Record<string, unknown>
    const blob = item.blob as Record<string, unknown> | undefined
    if (typeof blob?.id === "string" && /^[0-9a-f]{64}$/.test(blob.id)) ids.add(blob.id)
    Object.values(item).forEach(walk)
  }
  try {
    walk(JSON.parse(document))
  } catch {}
  return [...ids]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseRecord = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const serverUrl = (server: unknown) => {
  if (typeof server === "string") return server
  if (!isRecord(server)) return
  const http = isRecord(server.http) ? server.http : server
  return typeof http.url === "string" ? http.url : undefined
}

const folderKey = (folder: string | undefined) => (folder === undefined ? undefined : pathKey(folder))

const worktreeOf = (project: unknown) => (isRecord(project) && typeof project.worktree === "string" ? project.worktree : undefined)

/** `first` and then the items of `second` that have a key `first` has not. */
function union(first: unknown[], second: unknown[], keyOf: (item: unknown) => string | undefined) {
  const seen = new Set(first.flatMap((item) => keyOf(item) ?? []))
  const added = second.filter((item) => {
    const key = keyOf(item)
    if (key === undefined || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [...first, ...added]
}

/**
 * The saved servers and projects (`context/server.tsx`) of two states joined: the first one's order and values stay, the
 * second one adds the servers it has by address, the open and recently closed projects by folder (`pathKey`, so
 * `C:\a` and `c:/a/` are one), and the last project of the scopes the first has none for.
 */
export function mergeServerState(first: string, second: string) {
  const a = parseRecord(first)
  const b = parseRecord(second)
  if (!a) return second
  if (!b) return first
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})
  const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const perScope = (name: string, join: (mine: unknown[], theirs: unknown[]) => unknown[]) => {
    const mine = record(a[name])
    const theirs = record(b[name])
    return Object.fromEntries(
      [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].map((scope) => [scope, join(array(mine[scope]), array(theirs[scope]))]),
    )
  }
  return JSON.stringify({
    ...b,
    ...a,
    list: union(array(a.list), array(b.list), serverUrl),
    projects: perScope("projects", (mine, theirs) => union(mine, theirs, (project) => folderKey(worktreeOf(project)))),
    recentlyClosed: perScope("recentlyClosed", (mine, theirs) =>
      union(mine, theirs, (folder) => folderKey(typeof folder === "string" ? folder : undefined)).slice(0, RECENTLY_CLOSED_LIMIT),
    ),
    lastProject: { ...record(b.lastProject), ...record(a.lastProject) },
  })
}
