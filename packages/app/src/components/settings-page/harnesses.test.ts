import { describe, expect, test } from "bun:test"
import { parseHarness } from "./harnesses"

const shown = {
  id: "mango-harness-1",
  name: "Mango Harness 1",
  fixed: true,
  kind: "opencode",
  prompt: "You are a test.",
  tools: {},
  hooks: { "discipline-calls": { on: true, every: 12 } },
  texts: { "discipline-calls": "Keep the rules." },
  compaction: { first: "Write the summary.", missing: "{{missing}} left out." },
}

describe("parseHarness", () => {
  test("keeps the texts of the summary by name", () => {
    expect(parseHarness(shown)?.compaction).toEqual({ first: "Write the summary.", missing: "{{missing}} left out." })
  })

  test("a harness without them, or with one that is not a text, is not the one the agent gives", () => {
    const { compaction: _, ...without } = shown
    expect(parseHarness(without)).toBeUndefined()
    expect(parseHarness({ ...shown, compaction: { first: 3 } })).toBeUndefined()
  })
})
