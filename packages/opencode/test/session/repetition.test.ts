import { describe, expect, test } from "bun:test"
import { ARGUMENTS, TEXT, repeatedAt } from "@/session/repetition"

// A text of about `size` characters whose sentences all differ: it holds no repetition of its own.
const paragraph = (seed: string, size: number) => {
  const sentences = Array.from({ length: Math.ceil(size / 20) }, (_, index) => `${seed} ${index}. `).join("")
  return sentences.slice(0, size)
}
const times = (block: string, count: number) => block.repeat(count)

describe("text and reasoning: the same text again and again", () => {
  test("a short line repeated until it covers 8,000 characters", () => {
    const intro = "Let me check the page.\n"
    const line = "The page loads fine.\n"
    const text = intro + times(line, 400)
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe(intro + line)
  })

  test("a paragraph of about 1,500 characters repeated ten times", () => {
    const block = paragraph("Then I open the settings and read the value of the option. ", 1500) + "\n\n"
    const text = "Plan.\n\n" + times(block, 10)
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe("Plan.\n\n" + block)
  })

  test("sentences with no line break: the copy kept is whole, with its full stop", () => {
    const sentence = "I will open the page and check the title again. "
    const text = "Start of the answer. " + times(sentence, 260)
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe("Start of the answer. " + sentence)
  })

  test("a copy that is still being written at the end does not hide the loop", () => {
    const block = paragraph("Check the second column and compare it. ", 900) + "\n"
    const text = "Start.\n" + times(block, 12) + block.slice(0, 400)
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe("Start.\n" + block)
  })

  test("the keep length never grows past the text, and what is kept is a start of it", () => {
    const text = "a" + times("xyz\n", 3000)
    const keep = repeatedAt(text, TEXT)!
    expect(keep).toBeGreaterThan(0)
    expect(keep).toBeLessThan(text.length)
    expect(text.startsWith(text.slice(0, keep))).toBe(true)
  })

  test("nine repetitions are not a loop, ten are", () => {
    const block = paragraph("Compare the totals of the two files line by line. ", 1000)
    expect(repeatedAt("Intro. " + times(block, 9), TEXT)).toBeUndefined()
    expect(repeatedAt("Intro. " + times(block, 10), TEXT)).toBeDefined()
  })

  test("a pattern repeated many times under 8,000 characters is not a loop", () => {
    expect(repeatedAt("Intro.\n" + times("abc", 2000), TEXT)).toBeUndefined()
    expect(repeatedAt("Intro.\n" + times("0123456789", 700), TEXT)).toBeUndefined()
  })

  test("code with many identical closing lines among different lines is not a loop", () => {
    const code = Array.from(
      { length: 600 },
      (_, index) => `  if (value${index} > ${index}) {\n    run(${index})\n  }\n</div>\n}\n`,
    ).join("")
    expect(code.length).toBeGreaterThan(TEXT.chars)
    expect(repeatedAt(code, TEXT)).toBeUndefined()
  })

  test("a table whose rows differ is not a loop", () => {
    const rows = Array.from({ length: 400 }, (_, index) => `| row ${index} | ${index * 7} | ok |\n`).join("")
    expect(rows.length).toBeGreaterThan(TEXT.chars)
    expect(repeatedAt("| name | value | state |\n|---|---|---|\n" + rows, TEXT)).toBeUndefined()
    const csv = Array.from({ length: 900 }, (_, index) => `${index},${index % 7},north\n`).join("")
    expect(repeatedAt(csv, TEXT)).toBeUndefined()
  })

  test("a repeated run of blank characters is left to the blank rule", () => {
    expect(repeatedAt("Done.\n" + "\n".repeat(20_000), TEXT)).toBeUndefined()
    expect(repeatedAt("Done.\n" + " \n".repeat(20_000), TEXT)).toBeUndefined()
  })

  test("a text that does not repeat at its end is not a loop, however long", () => {
    const text = Array.from({ length: 5000 }, (_, index) => `Sentence number ${index} says something else.`).join(" ")
    expect(repeatedAt(text, TEXT)).toBeUndefined()
    expect(repeatedAt(times("same line again\n", 1000) + "and now something different.\n", TEXT)).toBeUndefined()
  })

  test("a loop that began long ago is found by its end", () => {
    const history = Array.from({ length: 4000 }, (_, index) => `Line ${index} of the earlier text.\n`).join("")
    const block = "I will now open the file and read it again.\n"
    const text = history + times(block, 300)
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe(history + block)
  })

  test("a big text is read only at its tail", () => {
    const history = "x".repeat(2_000_000) + "\n"
    const text = history + times("loop line number one\n", 600)
    const started = performance.now()
    const keep = repeatedAt(text, TEXT)
    expect(keep).toBeDefined()
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe("the arguments of a tool: a much higher threshold", () => {
  test("a file written with twenty identical blocks goes through", () => {
    const block = paragraph("<li>One item of the list, always the same.</li>", 1500) + "\n"
    const text = '{"filePath":"/p/index.html","content":"<ul>\\n' + times(block, 20)
    expect(text.length).toBeGreaterThan(24_000)
    expect(repeatedAt(text, ARGUMENTS)).toBeUndefined()
  })

  test("thirty copies covering 24,000 characters are a loop", () => {
    const block = paragraph("<li>One item of the list, always the same.</li>", 1000) + "\n"
    const text = '{"filePath":"/p/index.html","content":"<ul>\\n' + times(block, 40)
    const keep = repeatedAt(text, ARGUMENTS)
    expect(keep).toBeDefined()
    expect(text.slice(0, keep)).toBe('{"filePath":"/p/index.html","content":"<ul>\\n' + block)
  })

  test("many short copies under 24,000 characters are not a loop", () => {
    expect(repeatedAt('{"content":"' + times("ab", 10_000), ARGUMENTS)).toBeUndefined()
  })

  test("a line break written as an escape, again and again, is a loop", () => {
    expect(repeatedAt('{"content":"done' + "\\n".repeat(20_000), ARGUMENTS)).toBeDefined()
  })
})
