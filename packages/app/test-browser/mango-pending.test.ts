import { describe, expect, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { Platform } from "@/context/platform"
import type { ContextItem, Prompt } from "@/context/prompt"
import { bringBackPending, createPending, MAX_TRIES } from "@/context/mango"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { parseState } from "@/utils/mango-state"

// mango-code: the messages waiting for the model, in the saved list the app keeps, how they
// leave, and how they go back into the box.
const draft = (sessionID: string, content: string, model = { providerID: "mango", modelID: "3.6" }): FollowupDraft => ({
  sessionID,
  sessionDirectory: "C:\\progetto",
  prompt: [{ type: "text", content, start: 0, end: content.length }],
  context: [],
  agent: "build",
  model,
})

/** A desktop whose saved list holds `saved`. */
function desktop(saved: object = { items: {} }) {
  const written: string[] = []
  const storage: AsyncStorage = {
    getItem: async () => JSON.stringify(saved),
    setItem: async (_key, value) => void written.push(value),
    removeItem: async () => undefined,
    clear: async () => undefined,
    key: async () => null,
    getLength: async () => 0,
    length: Promise.resolve(0),
  }
  const platform: Platform = {
    platform: "desktop",
    openExternal: () => undefined,
    restart: async () => undefined,
    notify: async () => undefined,
    storage: () => storage,
  }
  return { platform, written }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
}

const where = { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 65536 }
const at = (model: object) => parseState({ revision: 1, catalog_revision: 1, model, downloads: [] })!
// a new object at each call, as each read of the state gives
const loading = () => at({ phase: "loading", model: "3.6", label: "Qwen", seconds: 3, where })
const ready = () => at({ phase: "ready", model: "ling", label: "Ling", where })
const text = (sent: FollowupDraft) => sent.prompt.map((part) => ("content" in part ? part.content : "")).join("")

/** A saved list ready to use, and a sender that holds each message until it is let go. */
async function setup() {
  const { platform, written } = desktop()
  const pending = createRoot(() => createPending(platform))
  await until(() => pending.ready())
  const sent: FollowupDraft[] = []
  const ids: string[] = []
  const held: { resolve: () => void; reject: (error: Error) => void }[] = []
  const send = (value: FollowupDraft, messageID: string) =>
    new Promise<unknown>((resolve, reject) => {
      sent.push(value)
      ids.push(messageID)
      held.push({ resolve: () => resolve(true), reject })
    })
  const gaveUp: unknown[] = []
  const deliver = (state: ReturnType<typeof at> | undefined) =>
    pending.deliver(state, send, (error) => gaveUp.push(error))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { pending, written, sent, ids, held, gaveUp, deliver, settle }
}

describe("the waiting messages", () => {
  test("queue in order; a message of an earlier start does not wait: it goes back to the box once", async () => {
    const saved = { items: { ses_1: [{ id: "old", run: "an-earlier-start", draft: draft("ses_1", "ieri") }] } }
    const { platform, written } = desktop(saved)
    const pending = createRoot(() => createPending(platform))
    await until(() => pending.ready())

    expect(pending.waiting("ses_1")).toEqual([])
    expect(pending.sessions()).toEqual([])
    pending.add(draft("ses_1", "uno"))
    pending.add(draft("ses_1", "due"))
    expect(pending.waiting("ses_1").map((item) => item.draft.prompt[0])).toMatchObject([
      { content: "uno" },
      { content: "due" },
    ])
    expect(pending.sessions()).toEqual(["ses_1"])

    const earlier = pending.takeEarlier("ses_1")
    expect(earlier.map((item) => item.id)).toEqual(["old"])
    expect(pending.takeEarlier("ses_1")).toEqual([])
    expect(pending.waiting("ses_1")).toHaveLength(2)

    // the X: one leaves the wait and is the next to go back to the box; the other still waits
    const [first] = pending.waiting("ses_1")
    pending.restore(first)
    expect(pending.waiting("ses_1").map((item) => item.draft.prompt[0])).toMatchObject([{ content: "due" }])
    expect(pending.takeEarlier("ses_1").map((item) => item.id)).toEqual([first.id])
    await until(() => written.length > 0)
    expect(written.at(-1)).toContain("due")
  })

  test("leave together, in order, to the model ready, once: a second look while they are sent sends nothing", async () => {
    const { pending, sent, held, deliver, settle } = await setup()
    pending.add(draft("ses_1", "uno"))
    pending.add(draft("ses_1", "due"))
    deliver(loading())
    expect(sent).toHaveLength(0)

    const read = ready()
    deliver(read)
    deliver(read)
    deliver(ready())
    expect(sent).toHaveLength(1)
    expect(text(sent[0])).toBe("uno\n\ndue")
    expect(sent[0].model).toEqual({ providerID: "mango", modelID: "ling" })
    // while they are sent, the X does nothing: they cannot be both in the box and sent
    expect(pending.sending("ses_1")).toBe(true)
    pending.restore(pending.waiting("ses_1")[0])
    expect(pending.takeEarlier("ses_1")).toEqual([])

    held[0].resolve()
    await settle()
    expect(pending.waiting("ses_1")).toEqual([])
    expect(pending.sending("ses_1")).toBe(false)
    deliver(ready())
    expect(sent).toHaveLength(1)
  })

  test("one that does not leave is tried again at each look, then says it did not leave, and «Retry» starts again", async () => {
    const { pending, sent, held, gaveUp, deliver, settle } = await setup()
    pending.add(draft("ses_1", "uno"))
    for (let i = 0; i < MAX_TRIES; i++) {
      deliver(ready())
      held[i].reject(new Error("the agent is reading its configuration"))
      await settle()
    }
    expect(sent).toHaveLength(MAX_TRIES)
    expect(pending.stuck("ses_1")).toBe(true)
    expect(gaveUp).toHaveLength(1)
    deliver(ready())
    expect(sent).toHaveLength(MAX_TRIES)

    pending.retry("ses_1")
    expect(pending.stuck("ses_1")).toBe(false)
    deliver(ready())
    expect(sent).toHaveLength(MAX_TRIES + 1)
    held[MAX_TRIES].resolve()
    await settle()
    expect(pending.waiting("ses_1")).toEqual([])
  })

  test("the tries start again when the model stops being ready and comes back", async () => {
    const { pending, sent, held, deliver, settle } = await setup()
    pending.add(draft("ses_1", "uno"))
    for (let i = 0; i < MAX_TRIES; i++) {
      deliver(ready())
      held[i].reject(new Error("no"))
      await settle()
    }
    expect(pending.stuck("ses_1")).toBe(true)
    deliver(loading())
    expect(pending.stuck("ses_1")).toBe(false)
    deliver(ready())
    expect(sent).toHaveLength(MAX_TRIES + 1)
  })

  test("a «/» command leaves by itself, in its place", async () => {
    const { pending, sent, held, deliver, settle } = await setup()
    for (const content of ["uno", "/review", "due"]) pending.add(draft("ses_1", content))
    deliver(ready())
    expect(sent.map(text)).toEqual(["uno"])
    held[0].resolve()
    await settle()
    expect(sent.map(text)).toEqual(["uno", "/review"])
    held[1].resolve()
    await settle()
    expect(sent.map(text)).toEqual(["uno", "/review", "due"])
    held[2].resolve()
    await settle()
    expect(pending.waiting("ses_1")).toEqual([])
  })

  test("moved to a model of another provider, they leave with it at once, while the local model still loads", async () => {
    const { pending, sent, deliver } = await setup()
    pending.add(draft("ses_1", "uno"))
    pending.add(draft("ses_1", "due"))
    pending.retarget("ses_1", { providerID: "openrouter", modelID: "kimi" })
    deliver(loading())
    expect(sent).toHaveLength(1)
    expect(sent[0].model).toEqual({ providerID: "openrouter", modelID: "kimi" })
  })

  test("with the other PC's engine they wait while it does not answer and leave, with their model, when it does", async () => {
    const { pending, sent, deliver } = await setup()
    pending.add(draft("ses_1", "uno", { providerID: "mango", modelID: "remote-qwen" }))
    deliver(at({ phase: "remote", address: "192.168.1.5:47098", models: ["Qwen"], reachable: false }))
    expect(sent).toHaveLength(0)
    deliver(at({ phase: "remote", address: "192.168.1.5:47098", models: ["Qwen"], reachable: true }))
    expect(sent).toHaveLength(1)
    expect(sent[0].model).toEqual({ providerID: "mango", modelID: "remote-qwen" })
  })
})

// As the app runs it: an effect on the state, read again by the poll.
describe("the waiting messages, sent from an effect on the state", () => {
  async function effect(first: ReturnType<typeof at>, failUntil = Infinity) {
    const { platform } = desktop()
    const pending = createRoot(() => createPending(platform))
    await until(() => pending.ready())
    const [state, setState] = createSignal(first)
    const ids: string[] = []
    let gaveUp = 0
    // a sender that fails `failUntil` times, as the agent does while it reads its configuration
    const send = async (_draft: FollowupDraft, messageID: string) => {
      ids.push(messageID)
      if (ids.length <= failUntil) throw new Error("503")
      return true
    }
    createRoot(() => createEffect(() => pending.deliver(state(), send, () => void gaveUp++)))
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    return { pending, setState, ids, gaveUp: () => gaveUp, settle }
  }

  test("a try that failed waits for the next read of the state: the three tries do not go in an instant", async () => {
    const run = await effect(ready())
    run.pending.add(draft("ses_1", "uno"))
    await run.settle()
    expect(run.ids).toHaveLength(1)
    run.setState(ready())
    await run.settle()
    expect(run.ids).toHaveLength(2)
    run.setState(ready())
    await run.settle()
    run.setState(ready())
    await run.settle()
    expect(run.ids).toHaveLength(MAX_TRIES)
    expect(run.pending.stuck("ses_1")).toBe(true)
    expect(run.gaveUp()).toBe(1)
  })

  test("towards a cloud model, with this PC's model loading, the tries stop at three", async () => {
    const run = await effect(loading(), 40)
    run.pending.add(draft("ses_1", "uno", { providerID: "openrouter", modelID: "kimi" }))
    for (let i = 0; i < 6; i++) {
      await run.settle()
      run.setState(loading())
    }
    await run.settle()
    expect(run.ids).toHaveLength(MAX_TRIES)
    expect(run.pending.stuck("ses_1")).toBe(true)
  })

  test("the tries of a message for this PC's model start again when the model leaves «ready» and comes back", async () => {
    const run = await effect(ready())
    run.pending.add(draft("ses_1", "uno"))
    for (let i = 1; i < MAX_TRIES; i++) {
      await run.settle()
      run.setState(ready())
    }
    await run.settle()
    expect(run.pending.stuck("ses_1")).toBe(true)
    run.setState(loading())
    await run.settle()
    expect(run.pending.stuck("ses_1")).toBe(false)
    run.setState(ready())
    await run.settle()
    expect(run.ids).toHaveLength(MAX_TRIES + 1)
  })

  test("every try of the same messages carries the same message id; the next messages another", async () => {
    const run = await effect(ready(), 1)
    run.pending.add(draft("ses_1", "uno"))
    await run.settle()
    run.setState(ready())
    await run.settle()
    expect(run.ids).toHaveLength(2)
    expect(run.ids[0]).toStartWith("msg_")
    expect(run.ids[1]).toBe(run.ids[0])
    expect(run.pending.waiting("ses_1")).toEqual([])
    run.pending.add(draft("ses_1", "due"))
    await run.settle()
    expect(run.ids).toHaveLength(3)
    expect(run.ids[2]).not.toBe(run.ids[0])
  })
})

describe("the box takes back what no longer waits", () => {
  test("an earlier start's message and one taken back with its X go before what is written, with their context", async () => {
    const shared = { key: "file:a.txt", type: "file" as const, path: "a.txt" }
    const saved = {
      items: {
        ses_1: [{ id: "old", run: "an-earlier-start", draft: { ...draft("ses_1", "ieri"), context: [shared] } }],
      },
    }
    const { platform } = desktop(saved)
    const pending = createRoot(() => createPending(platform))
    await until(() => pending.ready())

    let current: Prompt = [{ type: "text", content: "adesso", start: 0, end: 6 }]
    const added: ContextItem[] = []
    let focused = 0
    const [session] = createSignal<string | undefined>("ses_1")
    createRoot(() =>
      bringBackPending({
        sessionID: session,
        pending,
        prompt: {
          current: () => current,
          set: (next: Prompt) => void (current = next),
          context: { add: (item: ContextItem) => void added.push(item) },
        } as never,
        blank: () => current.length === 0,
        focus: () => void focused++,
      }),
    )
    await until(() => focused === 1)
    expect(current.map((part) => ("content" in part ? part.content : "")).join("")).toBe("ieri\n\nadesso")
    expect(added.map((item) => item.path)).toEqual(["a.txt"])
    expect(pending.takeEarlier("ses_1")).toEqual([])

    // the X on a message that waits: it goes back too, nothing of it leaves
    pending.add(draft("ses_1", "domani"))
    pending.restore(pending.waiting("ses_1")[0])
    await until(() => focused === 2)
    expect(current.map((part) => ("content" in part ? part.content : "")).join("")).toBe("domani\n\nieri\n\nadesso")
    expect(pending.waiting("ses_1")).toEqual([])
  })
})
