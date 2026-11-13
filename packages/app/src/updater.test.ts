import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as it } from "@/i18n/it"
import { updateSentence, type UpdaterState } from "./updater"

describe("what the update row says", () => {
  test("each state has its sentence, with the version or the percent it carries", () => {
    expect(updateSentence({ status: "checking" }, true)).toEqual({ key: "settings.help.update.checking" })
    expect(updateSentence({ status: "downloading", version: "0.2.0", percent: 40 }, true)).toEqual({
      key: "settings.help.update.downloading",
      params: { version: "0.2.0", percent: 40 },
    })
    expect(updateSentence({ status: "downloading", version: "0.2.0" }, true).params).toEqual({
      version: "0.2.0",
      percent: 0,
    })
    expect(updateSentence({ status: "ready", version: "0.2.0" }, true)).toEqual({
      key: "settings.help.update.ready",
      params: { version: "0.2.0" },
    })
    expect(updateSentence({ status: "up-to-date" }, true).key).toBe("settings.help.update.upToDate")
    expect(updateSentence({ status: "error", message: "offline" }, true).params).toEqual({ message: "offline" })
  })

  test("when nothing is going on, the row says whether the app looks by itself", () => {
    for (const state of [{ status: "idle" }, { status: "disabled" }] satisfies UpdaterState[]) {
      expect(updateSentence(state, true).key).toBe("settings.help.update.description")
      expect(updateSentence(state, false).key).toBe("settings.help.update.manual")
    }
  })

  test("a state that is doing something says it, whatever the choice of the check at the start", () => {
    expect(updateSentence({ status: "checking" }, false).key).toBe("settings.help.update.checking")
    expect(updateSentence({ status: "ready", version: "0.2.0" }, false).key).toBe("settings.help.update.ready")
  })

  test("the latest version says when it was checked: today at what time, or on which day", () => {
    const at = new Date(2026, 10, 12, 9, 12).getTime()
    const today = updateSentence({ status: "up-to-date" }, true, { at, now: at + 3_600_000, locale: "it" })
    expect(today).toEqual({ key: "settings.help.update.checkedToday", params: { time: "09:12" } })
    const before = updateSentence({ status: "up-to-date" }, true, { at, now: at + 86_400_000, locale: "it" })
    expect(before).toEqual({ key: "settings.help.update.checkedOn", params: { date: "12 novembre", time: "09:12" } })
    expect(updateSentence({ status: "up-to-date" }, true).key).toBe("settings.help.update.upToDate")
  })

  test("the sentences exist in both languages with the placeholders they are given", () => {
    const states: UpdaterState[] = [
      { status: "idle" },
      { status: "checking" },
      { status: "downloading", version: "1", percent: 2 },
      { status: "ready", version: "1" },
      { status: "installing", version: "1" },
      { status: "up-to-date" },
      { status: "error", message: "x" },
    ]
    const now = Date.now()
    for (const automatic of [true, false])
      for (const state of states)
        for (const checked of [undefined, { at: now, now, locale: "en" }, { at: 0, now, locale: "en" }]) {
          const sentence = updateSentence(state, automatic, checked)
          for (const dict of [en, it]) {
            const text = dict[sentence.key]
            expect(text, sentence.key).toBeString()
            for (const name of Object.keys(sentence.params ?? {}))
              expect(text, `${sentence.key} ${name}`).toContain(`{{${name}}}`)
          }
        }
  })
})
