import { describe, expect, test } from "bun:test"
import { titleFromText } from "../../src/session/title-text"

describe("titleFromText", () => {
  test("a short message becomes the title, capitalized", () => {
    expect(titleFromText("hello, can you help me with a file?")).toBe("Hello, can you help me with a file")
  })

  test("shortens to the first words with an ellipsis", () => {
    expect(titleFromText("Write a calculator in HTML with big buttons and the dark theme please")).toBe(
      "Write a calculator in HTML with big buttons…",
    )
  })

  test("strips markdown, links, code blocks and leading commands", () => {
    expect(titleFromText("/review **check** https://example.com/x `this`")).toBe("Check this")
    expect(titleFromText("```js\nconsole.log(1)\n```\nexplain the code")).toBe("Explain the code")
  })

  test("very long words do not exceed the cap", () => {
    const title = titleFromText("a".repeat(200))!
    expect(title.length).toBeLessThanOrEqual(61)
    expect(title.endsWith("…")).toBe(true)
  })

  test("without useful text there is no title", () => {
    expect(titleFromText("   \n ")).toBeUndefined()
    expect(titleFromText("```x```")).toBeUndefined()
  })
})
