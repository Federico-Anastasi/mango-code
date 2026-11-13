import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { leftEmptyDraft, nextTabAfterClose } from "./closed-tabs"
import { settingsHref, tabHref, tabKey, type DraftTab, type SessionTab, type Tab } from "./tabs"
import { migrateTabs } from "./tab-migration"
import type { ServerConnection } from "./server"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

function sessionTab(sessionId: string): SessionTab {
  return { type: "session", server, sessionId }
}

describe("tab migration", () => {
  test("drops null and malformed persisted tabs", () => {
    expect(
      migrateTabs([null, sessionTab("a"), { type: "session", server }, { type: "unknown", server }, "invalid"], server),
    ).toEqual([sessionTab("a")])
  })

  test("adds the fallback server to valid legacy tabs", () => {
    expect(migrateTabs([{ type: "session", sessionId: "a", dirBase64: "legacy" }], server)).toEqual([sessionTab("a")])
  })

  test("replaces invalid top-level persisted data", () => {
    expect(migrateTabs(null, server)).toEqual([])
    expect(migrateTabs({}, server)).toEqual([])
  })
})

describe("the settings tab", () => {
  test("is kept across a restart, with its server, and is one: one key, the page's address", () => {
    const settings = { type: "settings" as const, server }
    expect(migrateTabs([settings, { type: "settings" }], server)).toEqual([settings, settings])
    expect(tabKey(settings)).toBe("settings")
    expect(tabHref(settings)).toBe("/settings")
  })

  test("opens on a section and on a row of it", () => {
    expect(settingsHref()).toBe("/settings")
    expect(settingsHref({ section: "models" })).toBe("/settings?section=models")
    expect(settingsHref({ section: "general", focus: "Dettatura (microfono)" })).toBe(
      "/settings?section=general&focus=Dettatura+%28microfono%29",
    )
  })
})

describe("tab memory", () => {
  test("keeps state until its tab is removed", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      let disposed = 0
      const first = memory.ensure("tab", "prompt", () => {
        onCleanup(() => disposed++)
        return { value: "prompt" }
      })

      expect(memory.ensure("tab", "prompt", () => ({ value: "other" }))).toBe(first)
      expect(memory.get<typeof first>("tab", "prompt")).toBe(first)
      expect(memory.get("missing", "prompt")).toBeUndefined()
      expect(memory.ensure("other", "prompt", () => ({ value: "other" }))).not.toBe(first)

      memory.remove("tab")
      expect(disposed).toBe(1)
      expect(memory.ensure("tab", "prompt", () => ({ value: "new" }))).not.toBe(first)
      dispose()
    })
  })
})

describe("a new conversation left empty", () => {
  const draft = (draftID: string): DraftTab => ({ type: "draft", draftID, server, directory: "C:/progetti/sito" })

  test("is closed when the user goes to another tab", () => {
    const tabs: Tab[] = [sessionTab("a"), draft("one"), sessionTab("b")]
    expect(leftEmptyDraft(tabs, "draft:one", () => true)).toBe(1)
  })

  test("stays if something was written in it, or if nobody knows what it holds", () => {
    const tabs: Tab[] = [draft("one")]
    expect(leftEmptyDraft(tabs, "draft:one", () => false)).toBe(-1)
  })

  test("a conversation that has a title is never closed by itself, nor a tab that is gone", () => {
    const tabs: Tab[] = [sessionTab("a"), draft("one")]
    expect(leftEmptyDraft(tabs, tabKey(sessionTab("a")), () => true)).toBe(-1)
    expect(leftEmptyDraft(tabs, undefined, () => true)).toBe(-1)
    expect(leftEmptyDraft(tabs, "draft:missing", () => true)).toBe(-1)
  })
})

describe("closing a tab", () => {
  test("does not navigate when a background tab closes", () => {
    const tabs = [sessionTab("a"), sessionTab("b"), sessionTab("c")]

    expect(nextTabAfterClose(tabs, 1, false)).toBeUndefined()
    expect(nextTabAfterClose(tabs, 1, true)).toEqual(sessionTab("c"))
    expect(nextTabAfterClose([sessionTab("a")], 0, true)).toBeNull()
  })
})
