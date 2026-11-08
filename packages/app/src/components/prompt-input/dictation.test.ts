import { describe, expect, test } from "bun:test"
import { appendDictation, formatVoiceDuration, liveDictation, voiceFailureFromMediaError } from "./dictation"

const text = (content: string, start = 0) => ({ type: "text", content, start, end: start + content.length })

describe("appendDictation", () => {
  test("empty field: the dictated text is the whole prompt", () => {
    const next = appendDictation([text("")], "  open the file ")
    expect(next.value).toBe("open the file")
    expect(next.cursor).toBe(13)
    expect(next.parts).toEqual([text("open the file")])
  })

  test("at the end of a text, with a separating space", () => {
    const next = appendDictation([text("look at")], "the log")
    expect(next.value).toBe("look at the log")
    expect(next.parts).toEqual([text("look at the log")])
  })

  test("no double space if the text already ends with a space", () => {
    expect(appendDictation([text("look at ")], "the log").value).toBe("look at the log")
  })

  test("after a mention a new text part is added, images stay at the end", () => {
    const file = { type: "file", path: "a.ts", content: "@a.ts", start: 0, end: 5 }
    const image = { type: "image", id: "i1" }
    const next = appendDictation([file, image], "explain it")
    expect(next.value).toBe("@a.ts explain it")
    expect(next.parts as unknown[]).toEqual([file, text(" explain it", 5), image])
    expect(next.cursor).toBe(16)
  })
})

describe("voiceFailureFromMediaError", () => {
  const error = (name: string) => new DOMException("x", name)
  test("every getUserMedia error has its own message", () => {
    expect(voiceFailureFromMediaError(error("NotFoundError")).kind).toBe("no-device")
    expect(voiceFailureFromMediaError(error("NotAllowedError")).kind).toBe("denied")
    expect(voiceFailureFromMediaError(error("NotReadableError")).kind).toBe("busy")
    expect(voiceFailureFromMediaError(new TypeError("dunno")).kind).toBe("unsupported")
  })
})

test("formatVoiceDuration", () => {
  expect(formatVoiceDuration(0)).toBe("0:00")
  expect(formatVoiceDuration(7.9)).toBe("0:07")
  expect(formatVoiceDuration(75)).toBe("1:15")
})

describe("liveDictation", () => {
  const field = (initial: string) => {
    let parts = [text(initial)]
    const live = liveDictation(
      () => parts,
      (next) => {
        parts = next.parts
      },
    )
    return { live, value: () => parts.map((part) => part.content).join("") }
  }

  test("the partials appear in the field, each one in place of the previous, and the final takes their place", () => {
    const f = field("look at")
    f.live.partial("the")
    expect(f.value()).toBe("look at the")
    f.live.partial("the log of")
    expect(f.value()).toBe("look at the log of")
    f.live.final("the log of today")
    expect(f.value()).toBe("look at the log of today")
  })

  test("after a final the next sentence is added after it", () => {
    const f = field("")
    f.live.final("first sentence.")
    f.live.partial("second")
    expect(f.value()).toBe("first sentence. second")
    f.live.final("second sentence.")
    expect(f.value()).toBe("first sentence. second sentence.")
  })

  test("a partial without its final goes away, and the field is as it was", () => {
    const f = field("look at")
    f.live.partial("something")
    f.live.clear()
    expect(f.value()).toBe("look at")
    // with nothing in progress clear changes nothing
    f.live.clear()
    expect(f.value()).toBe("look at")
  })
})
