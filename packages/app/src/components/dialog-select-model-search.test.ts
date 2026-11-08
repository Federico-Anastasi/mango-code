import { describe, expect, test } from "bun:test"
import { compareModels, matchesModelSearch } from "./dialog-select-model-search"

describe("matchesModelSearch", () => {
  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("does not match unrelated searches", () => {
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })
})

describe("compareModels", () => {
  const model = (provider: string, name: string) => ({ provider: { id: provider }, name })

  test("local models keep the order of the configuration, the others are sorted by name", () => {
    const items = [
      model("openrouter", "Zeta"),
      model("mango", "Qwen3.8"),
      model("openrouter", "Alfa"),
      model("mango", "Bonsai 2"),
      model("mango", "Qwen3.6"),
    ]
    expect(items.sort(compareModels).map((item) => item.name)).toEqual(["Qwen3.8", "Bonsai 2", "Qwen3.6", "Alfa", "Zeta"])
  })
})
