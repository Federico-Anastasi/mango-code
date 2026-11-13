import { describe, expect, test } from "bun:test"
import { tabKey, type Tab } from "@/context/tabs"
import { parseState } from "@/utils/mango-state"
import { answeringTab, loadsDefaultNow } from "./answering"

const server = "local" as Tab["server"]
const session = (sessionId: string): Tab => ({ type: "session", server, sessionId })
const where = { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 131072 }
const state = (model: unknown) =>
  parseState({ revision: 1, catalog_revision: 1, model, default_model: "ling", downloads: [] })!

describe("the conversation that answers while the settings are open", () => {
  const tabs: Tab[] = [
    { type: "settings", server },
    { type: "draft", server, draftID: "d", directory: "C:/work" },
    session("a"),
    session("b"),
  ]
  const info = { [tabKey(session("a"))]: { title: "Invoices" }, [tabKey(session("b"))]: { title: "October report" } }

  test("is the open one that is working, named by its tab's title", () => {
    expect(answeringTab(tabs, info, (id) => id === "b")).toEqual({ title: "October report" })
    // a tab that has not learnt its title yet is still answering
    expect(answeringTab(tabs, {}, (id) => id === "b")).toEqual({ title: undefined })
  })

  test("is none when every conversation is still: the page has no line at the top", () => {
    expect(answeringTab(tabs, info, () => false)).toBeUndefined()
    expect(answeringTab([{ type: "settings", server }], info, () => true)).toBeUndefined()
  })
})

describe("a model made the default", () => {
  const ready = state({ phase: "ready", model: "3.6", label: "Qwen", where })

  test("loads at once when no conversation answers, so that the next one finds it ready", () => {
    expect(loadsDefaultNow(ready, "ling", false)).toBe(true)
    expect(loadsDefaultNow(state({ phase: "none" }), "ling", false)).toBe(true)
    expect(loadsDefaultNow(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No." }), "ling", false)).toBe(true)
    // another model on its way gives way to the default just chosen
    expect(loadsDefaultNow(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 3 }), "ling", false)).toBe(true)
  })

  test("leaves the model of a conversation that is answering where it is", () => {
    expect(loadsDefaultNow(ready, "ling", true)).toBe(false)
  })

  test("is not loaded again when it is the one in use or on its way, nor over the other PC's engine or lent cards", () => {
    expect(loadsDefaultNow(ready, "3.6", false)).toBe(false)
    expect(loadsDefaultNow(state({ phase: "loading", model: "ling", label: "Ling", seconds: 1 }), "ling", false)).toBe(false)
    expect(loadsDefaultNow(state({ phase: "remote", address: "a", models: [] }), "ling", false)).toBe(false)
    expect(loadsDefaultNow(state({ phase: "lent", model: "3.6", label: "Qwen" }), "ling", false)).toBe(false)
    expect(loadsDefaultNow(undefined, "ling", false)).toBe(false)
  })
})
