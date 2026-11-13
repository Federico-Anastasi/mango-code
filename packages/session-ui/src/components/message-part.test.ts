import { describe, expect, test } from "bun:test"
import { hasContent, readPartText } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("hasContent", () => {
  test("a reply with no text has nothing to show", () => {
    expect(hasContent(undefined)).toBe(false)
    expect(hasContent("")).toBe(false)
    expect(hasContent("  \n\t ")).toBe(false)
  })

  // A code block with nothing inside is drawn as an empty dark box.
  test("a reply made only of empty code blocks has nothing to show", () => {
    expect(hasContent("```\n```")).toBe(false)
    expect(hasContent("```text\n\n```\n")).toBe(false)
    expect(hasContent("~~~\n   \n~~~")).toBe(false)
    expect(hasContent("```\n```\n\n```json\n```")).toBe(false)
  })

  test("text, a code block with code and a block still being written have something to show", () => {
    expect(hasContent("hello")).toBe(true)
    expect(hasContent("```js\nlet x\n```")).toBe(true)
    expect(hasContent("```\n")).toBe(true)
    expect(hasContent("```\n```\nand then some text")).toBe(true)
  })
})
