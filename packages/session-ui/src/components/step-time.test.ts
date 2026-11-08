import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { dict as en } from "../../../ui/src/i18n/en"
import { dict as it } from "../../../ui/src/i18n/it"
import { elapsedMs, formatDuration, formatFullDate, formatMessageTime, stepStart } from "./step-time"

const tr = (dict: Record<string, string>) => (key: string, params?: Record<string, string | number | boolean>) =>
  (dict[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name) => String(params?.[name] ?? ""))
const tIt = tr(it) as Parameters<typeof formatDuration>[1]
const tEn = tr(en) as Parameters<typeof formatDuration>[1]

describe("elapsedMs", () => {
  test("uses the clock only until the step is finished", () => {
    expect(elapsedMs(1_000, undefined, 13_500)).toBe(12_500)
    expect(elapsedMs(1_000, 5_000, 13_500)).toBe(4_000)
  })
  test("without a start there is nothing to count", () => {
    expect(elapsedMs(undefined, undefined, 10)).toBeUndefined()
  })
  test("a clock running behind gives no negative times", () => {
    expect(elapsedMs(5_000, undefined, 4_000)).toBe(0)
  })
})

describe("formatDuration", () => {
  test("seconds, minutes, hours in Italian", () => {
    expect(formatDuration(12_900, tIt)).toBe("12 s")
    expect(formatDuration(59_999, tIt)).toBe("59 s")
    expect(formatDuration(64_000, tIt)).toBe("1 min 4 s")
    expect(formatDuration(3_720_000, tIt)).toBe("1 h 2 min")
  })
  test("in English", () => {
    expect(formatDuration(12_000, tEn)).toBe("12s")
    expect(formatDuration(64_000, tEn)).toBe("1m 4s")
    expect(formatDuration(3_720_000, tEn)).toBe("1h 2m")
  })
  test("zero and negative", () => {
    expect(formatDuration(0, tIt)).toBe("0 s")
    expect(formatDuration(-5, tIt)).toBe("0 s")
  })
})

describe("formatMessageTime", () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime()
  const at = (month: number, day: number, h: number, m: number, year = 2026) =>
    new Date(year, month, day, h, m).getTime()

  test("today and yesterday", () => {
    expect(formatMessageTime(at(9, 30, 13, 7), now, "it")).toBe("oggi 13:07")
    expect(formatMessageTime(at(9, 29, 18, 22), now, "it")).toBe("ieri 18:22")
    expect(formatMessageTime(at(9, 30, 13, 7), now, "en")).toBe("today 1:07 PM")
  })
  test("midnight: 23:50 yesterday is not today", () => {
    expect(formatMessageTime(at(9, 29, 23, 50), at(9, 30, 0, 10), "it")).toBe("ieri 23:50")
  })
  test("older: short date, with the year if different", () => {
    expect(formatMessageTime(at(9, 12, 9, 5), now, "it")).toContain("12 ott")
    expect(formatMessageTime(at(9, 12, 9, 5), now, "it")).not.toContain("2026")
    expect(formatMessageTime(at(11, 24, 9, 5, 2025), now, "it")).toContain("2025")
  })
  test("full date for the tooltip", () => {
    const full = formatFullDate(at(9, 30, 13, 7), "it")
    expect(full).toContain("30 ottobre 2026")
    expect(full).toContain("13:07")
  })
})

describe("stepStart", () => {
  const message = { time: { created: 100 } } as Message
  const part = (id: string, type: string, time?: { start: number; end?: number }) =>
    ({ id, type, time }) as unknown as Part

  test("starts from the end of the reasoning before the tool", () => {
    const parts = [part("a", "reasoning", { start: 120, end: 180 }), part("b", "tool")]
    expect(stepStart(message, parts, "b")).toBe(180)
  })
  test("without reasoning it starts from the message creation", () => {
    expect(stepStart(message, [part("b", "tool")], "b")).toBe(100)
  })
  test("ignores a reasoning still running and the ones that follow", () => {
    const parts = [
      part("a", "reasoning", { start: 120 }),
      part("b", "tool"),
      part("c", "reasoning", { start: 300, end: 400 }),
    ]
    expect(stepStart(message, parts, "b")).toBe(100)
  })
})
