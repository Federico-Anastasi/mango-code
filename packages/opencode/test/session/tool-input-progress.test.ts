import { describe, expect, test } from "bun:test"
import { toolInputProgress } from "@/session/tool-input-progress"

describe("tool input progress", () => {
  test("nothing received: zero lines", () => {
    expect(toolInputProgress("")).toEqual({ chars: 0, lines: 0 })
  })

  test("counts the lines from the line breaks of the JSON and reads the file as soon as it is complete", () => {
    const partial = '{"filePath":"C:\\\\site\\\\index.html","content":"<html>\\n<body>\\n  <p>hello'
    expect(toolInputProgress(partial)).toEqual({ chars: partial.length, lines: 3, file: "C:\\site\\index.html" })
  })

  test("file still half written: it is read later", () => {
    const partial = '{"filePath":"C:\\\\site\\\\ind'
    expect(toolInputProgress(partial).file).toBeUndefined()
    expect(toolInputProgress(partial).lines).toBe(1)
  })

  test("truncated escape sequence in the path: no error", () => {
    expect(toolInputProgress('{"filePath":"a\\"').file).toBeUndefined()
  })
})
