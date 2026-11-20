import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createMemo } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted, rememberSpellings } from "@/utils/persist"
import { folderKey } from "@/utils/path-key"
import { ServerScope } from "@/utils/server-scope"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type ServerProjectState = {
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  recentlyClosed: Record<string, string[]>
}
const HEALTH_POLL_INTERVAL_MS = 10_000
// The store retains more history than is displayed. Consumers filter recently closed entries
// against the live project list (dropping deleted projects) and then cap the visible count via
// RECENTLY_CLOSED_DISPLAY_LIMIT. Retaining extra history ensures entries that are temporarily
// filtered out do not evict still-visible ones from the persisted store.
const RECENTLY_CLOSED_HISTORY_LIMIT = 16
export const RECENTLY_CLOSED_DISPLAY_LIMIT = 5

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function migrateCanonicalLocalServerState(value: unknown, canonicalLocalServer?: ServerConnection.Key) {
  if (!canonicalLocalServer || canonicalLocalServer === "local") return value
  if (!isRecord(value)) return value
  const projects = isRecord(value.projects) ? value.projects : undefined
  const lastProject = isRecord(value.lastProject) ? value.lastProject : undefined
  const previousProjects = projects?.[canonicalLocalServer]
  const previousLastProject = lastProject?.[canonicalLocalServer]
  if (!Array.isArray(previousProjects) && typeof previousLastProject !== "string") return value

  const next = { ...value }
  if (projects && Array.isArray(previousProjects)) {
    const local = Array.isArray(projects.local) ? projects.local : []
    const worktrees = new Set(
      local.flatMap((project) =>
        isRecord(project) && typeof project.worktree === "string" ? [folderKey(project.worktree)] : [],
      ),
    )
    const migrated = previousProjects.filter((project) => {
      if (!isRecord(project) || typeof project.worktree !== "string") return true
      const key = folderKey(project.worktree)
      if (worktrees.has(key)) return false
      worktrees.add(key)
      return true
    })
    const nextProjects: Record<string, unknown> = { ...projects, local: [...local, ...migrated] }
    delete nextProjects[canonicalLocalServer]
    next.projects = nextProjects
  }
  if (lastProject && typeof previousLastProject === "string") {
    const nextLastProject = { ...lastProject }
    if (typeof nextLastProject.local !== "string") nextLastProject.local = previousLastProject
    delete nextLastProject[canonicalLocalServer]
    next.lastProject = nextLastProject
  }
  return next
}

const worktreeKey = (project: unknown) =>
  isRecord(project) && typeof project.worktree === "string" ? folderKey(project.worktree) : undefined

// The same value for every scope that did not change, so that a state without duplicates comes back as it is.
const mapScopes = (field: unknown, change: (scope: string, value: unknown) => unknown) => {
  if (!isRecord(field)) return field
  const entries = Object.entries(field).map(([scope, value]) => [scope, change(scope, value)] as const)
  return entries.every(([scope, value]) => value === field[scope]) ? field : Object.fromEntries(entries)
}

const uniqueBy = (items: unknown[], key: (item: unknown) => string | undefined) => {
  const seen = new Set<string>()
  const unique = items.filter((item) => {
    const k = key(item)
    if (k === undefined) return true
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  return unique.length === items.length ? items : unique
}

// Projects saved before folders were compared by `folderKey` can be there twice, in two spellings of the same
// folder: the first one stays, open if any of its copies was, and what refers to the folder by the other spelling (the
// last project, the recently closed) follows the one that stays. `merged` is told the spellings of each folder that was
// merged, the one that stays first. A state that has none comes back as it is.
export function mergeDuplicateProjects(value: unknown, merged?: (spellings: string[]) => void) {
  if (!isRecord(value)) return value
  const kept = new Map<string, Map<string, string>>()
  const projects = mapScopes(value.projects, (scope, list) => {
    if (!Array.isArray(list)) return list
    const spellings = new Map<string, string>()
    kept.set(scope, spellings)
    const opened = new Set<string>()
    const written = new Map<string, string[]>()
    for (const project of list) {
      const key = worktreeKey(project)
      if (key === undefined) continue
      const worktree = (project as StoredProject).worktree
      if (!spellings.has(key)) spellings.set(key, worktree)
      if (!written.get(key)?.includes(worktree)) written.set(key, [...(written.get(key) ?? []), worktree])
      if ((project as StoredProject).expanded === true) opened.add(key)
    }
    for (const spellingsOfFolder of written.values()) if (spellingsOfFolder.length > 1) merged?.(spellingsOfFolder)
    const unique = uniqueBy(list, worktreeKey).map((project) => {
      const key = worktreeKey(project)
      return key !== undefined && opened.has(key) && (project as StoredProject).expanded !== true
        ? { ...(project as StoredProject), expanded: true }
        : project
    })
    return unique.length === list.length && unique.every((project, i) => project === list[i]) ? list : unique
  })
  const lastProject = mapScopes(value.lastProject, (scope, worktree) => {
    if (typeof worktree !== "string") return worktree
    return kept.get(scope)?.get(folderKey(worktree)) ?? worktree
  })
  const recentlyClosed = mapScopes(value.recentlyClosed, (scope, list) => {
    if (!Array.isArray(list)) return list
    const open = kept.get(scope)
    const key = (worktree: unknown) => (typeof worktree === "string" ? folderKey(worktree) : undefined)
    const closed = list.filter((worktree) => {
      const k = key(worktree)
      return k === undefined || !open?.has(k)
    })
    return uniqueBy(closed.length === list.length ? list : closed, key)
  })
  const next = { ...value }
  if (projects !== value.projects) next.projects = projects
  if (lastProject !== value.lastProject) next.lastProject = lastProject
  if (recentlyClosed !== value.recentlyClosed) next.recentlyClosed = recentlyClosed
  return Object.keys(next).every((field) => next[field] === value[field]) ? value : next
}

export function createServerProjects<T extends ServerProjectState>(input: {
  scope: Accessor<ServerScope>
  store: Store<T>
  setStore: SetStoreFunction<T>
}) {
  const setStore = input.setStore as unknown as SetStoreFunction<ServerProjectState>
  const current = () => input.store.projects[input.scope()] ?? []
  const currentClosed = () => input.store.recentlyClosed?.[input.scope()] ?? []
  const remove = (directory: string) => {
    setStore(
      "projects",
      input.scope(),
      current().filter((project) => folderKey(project.worktree) !== folderKey(directory)),
    )
  }
  return {
    list: current,
    recentlyClosed: currentClosed,
    remove,
    open(directory: string) {
      const scope = input.scope()
      const key = folderKey(directory)
      const closed = currentClosed()
      if (closed.some((worktree) => folderKey(worktree) === key)) {
        setStore(
          "recentlyClosed",
          scope,
          closed.filter((worktree) => folderKey(worktree) !== key),
        )
      }
      if (current().some((project) => folderKey(project.worktree) === key)) return
      setStore("projects", scope, [{ worktree: directory, expanded: true }, ...current()])
    },
    // User-initiated close: removes the project and records it in recently closed.
    // Internal, non-user removals (e.g. sandbox/worktree normalization) should use remove().
    close(directory: string) {
      remove(directory)
      const key = folderKey(directory)
      const closed = [directory, ...currentClosed().filter((worktree) => folderKey(worktree) !== key)].slice(
        0,
        RECENTLY_CLOSED_HISTORY_LIMIT,
      )
      setStore("recentlyClosed", input.scope(), closed)
    },
    expand(directory: string) {
      const index = current().findIndex((project) => folderKey(project.worktree) === folderKey(directory))
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", true)
    },
    collapse(directory: string) {
      const index = current().findIndex((project) => folderKey(project.worktree) === folderKey(directory))
      if (index !== -1) setStore("projects", input.scope(), index, "expanded", false)
    },
    move(directory: string, toIndex: number) {
      const fromIndex = current().findIndex((project) => folderKey(project.worktree) === folderKey(directory))
      if (fromIndex === -1 || fromIndex === toIndex) return
      const next = [...current()]
      const [item] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, item)
      setStore("projects", input.scope(), next)
    },
    last() {
      return input.store.lastProject[input.scope()]
    },
    touch(directory: string) {
      setStore("lastProject", input.scope(), directory)
    },
  }
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>(
    input.props?.map((v) => [ServerConnection.key(v), v]) ?? [],
  )

  for (const value of input.stored) {
    const conn: ServerConnection.Http =
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : "http" in value
          ? value
          : { type: "http", http: value }
    const key = ServerConnection.key(conn)

    const existing = deduped.get(key)
    if (existing)
      deduped.set(key, {
        ...existing,
        ...conn,
        http: { ...existing.http, ...conn.http },
      })
    else deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export namespace ServerConnection {
  type Base = { displayName?: string; label?: string }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }

  export const builtin = (conn: Any) => conn.type === "sidecar" && conn.variant === "base"
  export const local = (conn?: Any) =>
    !!conn && (builtin(conn) || (conn.type === "http" && isLocalHost(conn.http.url) === "local"))
}

export function nextServerAfterRemoval(
  servers: ServerConnection.Any[],
  removed: ServerConnection.Key,
  fallback: ServerConnection.Key,
) {
  const remaining = servers.filter((server) => ServerConnection.key(server) !== removed)
  const next = remaining.find((server) => ServerConnection.key(server) === fallback) ?? remaining[0]
  return next ? ServerConnection.key(next) : fallback
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  gate: true,
  init: (props: {
    defaultServer: ServerConnection.Key
    canonicalLocalServer?: ServerConnection.Key
    servers?: Array<ServerConnection.Any>
  }) => {
    const [store, setStore, _, ready] = persisted(
      {
        ...Persist.global("server", ["server.v3"]),
        migrate: (value) =>
          mergeDuplicateProjects(migrateCanonicalLocalServerState(value, props.canonicalLocalServer), rememberSpellings),
      },
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        recentlyClosed: {} as Record<string, string[]>,
      }),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      return resolveServerList({ stored: store.list, props: props.servers })
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
    })

    function setActive(input: ServerConnection.Key) {
      if (state.active !== input) setState("active", input)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn: ServerConnection.Http = { ...input, authToken: undefined, http: { ...input.http, url: url_ } }
      return batch(() => {
        const existing = store.list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", store.list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const next = nextServerAfterRemoval(allServers(), key, props.defaultServer)
      const list = store.list.filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) setState("active", next)
      })
    }

    const isReady = Object.assign(
      createMemo(() => ready() && !!state.active),
      { promise: ready.promise },
    )

    const scope = (key = state.active) => ServerScope.fromServerKey(key, props.canonicalLocalServer)
    const projects = createServerProjects({ scope, store, setStore })
    const projectStores = new Map<ServerConnection.Key, ReturnType<typeof createServerProjects>>()
    const projectsForServer = (key: ServerConnection.Key) => {
      const existing = projectStores.get(key)
      if (existing) return existing
      const next = createServerProjects({ scope: () => scope(key), store, setStore })
      projectStores.set(key, next)
      return next
    }
    const current: Accessor<ServerConnection.Any | undefined> = createMemo(
      () => allServers().find((s) => ServerConnection.key(s) === state.active) ?? allServers()[0],
    )
    const isLocal = createMemo(() => ServerConnection.local(current()))

    return {
      ready: isReady,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      setActive,
      add,
      remove,
      scope,
      projects: {
        ...projects,
        forServer: projectsForServer,
      },
    }
  },
})
