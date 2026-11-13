import { describe, expect, test } from "bun:test"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import type { Prompt } from "@/context/prompt"
import { batches, combine, joinPrompts, pendingText, split, withTimeout, type PendingItem } from "./mango-pending"

const text = (content: string, start = 0) => ({ type: "text" as const, content, start, end: start + content.length })
const draft = (prompt: Prompt, extra: Partial<FollowupDraft> = {}): FollowupDraft => ({
  sessionID: "ses_1",
  sessionDirectory: "C:\\progetto",
  prompt,
  context: [],
  agent: "build",
  model: { providerID: "mango", modelID: "3.6" },
  ...extra,
})
const item = (id: string, run: string, value: FollowupDraft): PendingItem => ({ id, run, draft: value })

describe("the waiting messages of a conversation", () => {
  test("leave together, in order, a blank line between them, with the mentions moved along", () => {
    const first = [text("Riordina "), { type: "file" as const, path: "a.txt", content: "@a.txt", start: 9, end: 15 }]
    const joined = joinPrompts([first, [text("poi novembre")]])
    expect(joined.map((part) => ("content" in part ? part.content : "")).join("")).toBe(
      "Riordina @a.txt\n\npoi novembre",
    )
    expect(joined[1]).toMatchObject({ start: 9, end: 15 })
    expect(joined[3]).toMatchObject({ content: "poi novembre", start: 17, end: 29 })
  })

  test("as one message to the model now ready, with their context together and once", () => {
    const shared = { key: "f:a", type: "file" as const, path: "a.txt" }
    const combined = combine(
      [
        item("1", "run", draft([text("uno")], { context: [shared] })),
        item(
          "2",
          "run",
          draft([text("due")], { context: [shared, { key: "f:b", type: "file", path: "b.txt" }], agent: "team" }),
        ),
      ],
      { providerID: "mango", modelID: "ling" },
    )!
    expect(pendingText(combined)).toBe("uno\n\ndue")
    expect(combined.context.map((c) => c.key)).toEqual(["f:a", "f:b"])
    expect(combined.model).toEqual({ providerID: "mango", modelID: "ling" })
    expect(combined.agent).toBe("team")
    // a message for another provider keeps its model
    const cloud = combine(
      [item("3", "run", draft([text("x")], { model: { providerID: "openrouter", modelID: "g" } }))],
      {
        providerID: "mango",
        modelID: "ling",
      },
    )!
    expect(cloud.model).toEqual({ providerID: "openrouter", modelID: "g" })
    expect(combine([])).toBeUndefined()
  })

  test("those of an earlier start of the app do not leave: they go back into the box", () => {
    const list = [item("old", "earlier", draft([text("ieri")])), item("new", "now", draft([text("oggi")]))]
    expect(split(list, "now")).toEqual({ waiting: [list[1]], earlier: [list[0]] })
    expect(split(undefined, "now")).toEqual({ waiting: [], earlier: [] })
  })
})

describe("the order they leave in", () => {
  test("messages written one after the other go as one; a «/» command goes by itself, in its place", () => {
    const list = ["uno", "due", "/review", "tre", "/compact", "/review"].map((content, index) =>
      item(String(index), "run", draft([text(content)])),
    )
    expect(batches(list).map((group) => group.map((one) => one.id))).toEqual([["0", "1"], ["2"], ["3"], ["4"], ["5"]])
    expect(batches([])).toEqual([])
  })
})

describe("a send that never answers", () => {
  test("fails after its time, and one that answers in time is not touched", async () => {
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toThrow("no answer")
    expect(await withTimeout(Promise.resolve("sent"), 20)).toBe("sent")
  })
})
