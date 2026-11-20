import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createServerProjects,
  mergeDuplicateProjects,
  migrateCanonicalLocalServerState,
  nextServerAfterRemoval,
  resolveServerList,
  ServerConnection,
} from "./server"
import { ServerScope } from "@/utils/server-scope"

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })
})

test("treats WSL sidecars as remote server connections", () => {
  expect(
    ServerConnection.local({
      type: "sidecar",
      variant: "wsl",
      distro: "Debian",
      http: { url: "http://127.0.0.1:4097" },
    }),
  ).toBe(false)
  expect(ServerConnection.local({ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } })).toBe(
    true,
  )
  expect(ServerConnection.local({ type: "http", http: { url: "http://localhost:4096" } })).toBe(true)
  expect(ServerConnection.local({ type: "http", http: { url: "https://server.example.test" } })).toBe(false)
})

test("active server removal falls back across built-in and persisted servers", () => {
  const local = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } } as const
  const debian = {
    type: "sidecar",
    variant: "wsl",
    distro: "Debian",
    http: { url: "http://127.0.0.1:4097" },
  } as const

  expect(
    nextServerAfterRemoval(
      [local, debian],
      ServerConnection.Key.make("wsl:Debian"),
      ServerConnection.Key.make("sidecar"),
    ),
  ).toBe(ServerConnection.Key.make("sidecar"))
})

describe("createServerProjects", () => {
  test("keeps active and explicit server buckets in one reactive store", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const active = createServerProjects({ scope, store, setStore })
      const remote = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })

      remote.open("/repo")
      expect(remote.list()).toEqual([{ worktree: "/repo", expanded: true }])
      expect(active.list()).toEqual([])

      const adopted = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })
      expect(adopted.list()).toEqual([{ worktree: "/repo", expanded: true }])

      adopted.close("/repo")
      expect(remote.list()).toEqual([])
      dispose()
    })
  })

  test("tracks recently closed projects and drops them when reopened", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/a")
      projects.open("/b")
      projects.close("/a")
      expect(projects.recentlyClosed()).toEqual(["/a"])

      projects.close("/b")
      expect(projects.recentlyClosed()).toEqual(["/b", "/a"])

      projects.open("/a")
      expect(projects.recentlyClosed()).toEqual(["/b"])
      expect(projects.list()).toEqual([{ worktree: "/a", expanded: true }])
      dispose()
    })
  })

  test("remove drops a project without recording it as recently closed", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/repo/subdir")
      projects.remove("/repo/subdir")
      expect(projects.list()).toEqual([])
      expect(projects.recentlyClosed()).toEqual([])
      dispose()
    })
  })

  test("retains recently closed history beyond the visible display limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      // Closing 6 projects keeps all 6 in the store even though only 5 are displayed;
      // this prevents display-filtered entries from evicting still-visible ones.
      for (const dir of ["/1", "/2", "/3", "/4", "/5", "/6"]) {
        projects.open(dir)
        projects.close(dir)
      }
      expect(projects.recentlyClosed()).toEqual(["/6", "/5", "/4", "/3", "/2", "/1"])
      dispose()
    })
  })

  test("caps recently closed history at the store limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      for (let i = 1; i <= 20; i++) {
        projects.open(`/p${i}`)
        projects.close(`/p${i}`)
      }
      expect(projects.recentlyClosed()).toHaveLength(16)
      expect(projects.recentlyClosed()[0]).toBe("/p20")
      expect(projects.recentlyClosed().at(-1)).toBe("/p5")
      dispose()
    })
  })

  test("dedupes recently closed entries by normalized path", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.close("/repo")
      projects.close("/repo/")
      expect(projects.recentlyClosed()).toEqual(["/repo/"])
      dispose()
    })
  })

  test("opens one project for a Windows folder however its path is written", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("C:\\x")
      projects.open("c:/x/")
      projects.open("C:/X")
      expect(projects.list()).toEqual([{ worktree: "C:\\x", expanded: true }])

      projects.open("/Repo")
      projects.open("/repo")
      expect(projects.list().map((project) => project.worktree)).toEqual(["/repo", "/Repo", "C:\\x"])
      dispose()
    })
  })

  test("expand, collapse, move and remove find the project by the folder, not by its spelling", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("C:\\x")
      projects.open("C:\\y")
      projects.collapse("c:/x/")
      expect(projects.list().find((project) => project.worktree === "C:\\x")?.expanded).toBe(false)
      projects.expand("C:/X")
      expect(projects.list().find((project) => project.worktree === "C:\\x")?.expanded).toBe(true)
      projects.move("c:/x", 0)
      expect(projects.list().map((project) => project.worktree)).toEqual(["C:\\x", "C:\\y"])
      projects.remove("c:/y/")
      expect(projects.list().map((project) => project.worktree)).toEqual(["C:\\x"])
      dispose()
    })
  })

  test("closing by another spelling lists the folder once, and reopening takes it off the closed ones", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("C:\\x")
      projects.close("c:/x")
      expect(projects.list()).toEqual([])
      expect(projects.recentlyClosed()).toEqual(["c:/x"])
      projects.close("C:\\X\\")
      expect(projects.recentlyClosed()).toEqual(["C:\\X\\"])
      projects.open("C:\\x")
      expect(projects.recentlyClosed()).toEqual([])
      dispose()
    })
  })
})

describe("mergeDuplicateProjects", () => {
  test("keeps the first of the projects saved twice, in its own spelling, and the rest as they are", () => {
    const merged = mergeDuplicateProjects({
      list: [],
      projects: {
        local: [
          { worktree: "C:\\x", expanded: false },
          { worktree: "/Repo", expanded: true },
          { worktree: "c:/x/", expanded: true },
          { worktree: "/repo", expanded: true },
          { worktree: "D:\\y", expanded: true },
          { worktree: "d:/Y", expanded: false },
        ],
        "https://other.example": [{ worktree: "/a", expanded: true }],
      },
      lastProject: { local: "d:/Y", "https://other.example": "/a" },
      recentlyClosed: { local: ["c:/z", "C:\\Z\\", "/q"] },
    })
    expect(merged).toEqual({
      list: [],
      projects: {
        local: [
          { worktree: "C:\\x", expanded: true },
          { worktree: "/Repo", expanded: true },
          { worktree: "/repo", expanded: true },
          { worktree: "D:\\y", expanded: true },
        ],
        "https://other.example": [{ worktree: "/a", expanded: true }],
      },
      lastProject: { local: "D:\\y", "https://other.example": "/a" },
      recentlyClosed: { local: ["c:/z", "/q"] },
    })
  })

  test("the kept project is open if any of its copies was, and the last project follows the spelling that stays", () => {
    const merged = mergeDuplicateProjects({
      projects: {
        local: [
          { worktree: "C:\\x", expanded: false },
          { worktree: "c:/X", expanded: true },
        ],
      },
      lastProject: { local: "C:/X/" },
    }) as { projects: { local: Array<{ worktree: string; expanded: boolean }> }; lastProject: { local: string } }
    expect(merged.projects.local).toEqual([{ worktree: "C:\\x", expanded: true }])
    expect(merged.lastProject.local).toBe("C:\\x")
  })

  test("a folder that is open is not also among the recently closed, whichever way it is written", () => {
    const merged = mergeDuplicateProjects({
      projects: { local: [{ worktree: "C:\\x", expanded: true }], other: [{ worktree: "C:\\y", expanded: true }] },
      recentlyClosed: { local: ["c:/X/", "C:\\gone", "c:/y"], other: ["c:/Y", "C:\\x"] },
    })
    expect(merged).toEqual({
      projects: { local: [{ worktree: "C:\\x", expanded: true }], other: [{ worktree: "C:\\y", expanded: true }] },
      recentlyClosed: { local: ["C:\\gone", "c:/y"], other: ["C:\\x"] },
    })
  })

  test("tells the spellings of each folder that was merged, the one that stays first, so that what was kept under the others is not lost", () => {
    const merged: string[][] = []
    mergeDuplicateProjects(
      {
        projects: {
          local: [
            { worktree: "C:\\x", expanded: false },
            { worktree: "C:\\y", expanded: false },
            { worktree: "c:/X/", expanded: true },
            { worktree: "C:\\X", expanded: true },
            { worktree: "/Repo", expanded: true },
            { worktree: "/repo", expanded: true },
          ],
        },
      },
      (spellings) => merged.push(spellings),
    )
    expect(merged).toEqual([["C:\\x", "c:/X/", "C:\\X"]])
    const none: string[][] = []
    mergeDuplicateProjects({ projects: { local: [{ worktree: "C:\\x", expanded: true }] } }, (spellings) => none.push(spellings))
    expect(none).toEqual([])
  })

  test("returns a state without duplicates, or one it does not know, as it is", () => {
    const clean = { projects: { local: [{ worktree: "C:\\x", expanded: true }] }, recentlyClosed: { local: [] } }
    expect(mergeDuplicateProjects(clean)).toBe(clean)
    expect(mergeDuplicateProjects(undefined)).toBeUndefined()
    expect(mergeDuplicateProjects("text")).toBe("text")
    expect(mergeDuplicateProjects({ projects: { local: "broken" } })).toEqual({ projects: { local: "broken" } })
  })
})

describe("migrateCanonicalLocalServerState", () => {
  test("moves an existing canonical web bucket into local scope", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          list: [],
          projects: { "https://opencode.example.com": [{ worktree: "/remote", expanded: true }] },
          lastProject: { "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      list: [],
      projects: { local: [{ worktree: "/remote", expanded: true }] },
      lastProject: { local: "/remote" },
    })
  })

  test("preserves existing local state while merging a canonical web bucket", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          projects: {
            local: [{ worktree: "/local", expanded: false }],
            "https://opencode.example.com": [
              { worktree: "/local", expanded: true },
              { worktree: "/remote", expanded: true },
            ],
          },
          lastProject: { local: "/local", "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      projects: {
        local: [
          { worktree: "/local", expanded: false },
          { worktree: "/remote", expanded: true },
        ],
      },
      lastProject: { local: "/local" },
    })
  })
})
