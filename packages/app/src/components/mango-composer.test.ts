import { beforeAll, describe, expect, test } from "bun:test"

// «X is ready» is the explanation of the first time: once read, it is not said again, after a restart either.
describe("the line of a model just ready", () => {
  let line: typeof import("./mango-composer")
  beforeAll(async () => {
    localStorage.removeItem("mango.readyHint.seen")
    line = await import("./mango-composer")
  })

  test("it is said when the model has just become ready and was never read", () => {
    expect(line.showReady(true)).toBe(true)
    expect(line.showReady(false)).toBe(false)
  })

  test("«Got it» closes it for good: the next model ready and the next start do not say it again", () => {
    let dismissed = false
    line.dismissReady({
      justReady: () => true,
      dismissReady: () => {
        dismissed = true
        return false
      },
    })
    expect(dismissed).toBe(true)
    expect(line.showReady(true)).toBe(false)
    // what the next start reads
    expect(localStorage.getItem("mango.readyHint.seen")).toBe("1")
  })
})

// On a phone the top bar has no model name and a conversation has no gear: the hint must not point there.
describe("the hint of a model just ready", () => {
  test("a narrow window gets the one that points only under the box and to the settings", async () => {
    const { readyHintKey } = await import("./mango-composer")
    expect(readyHintKey(true)).toBe("mango.status.readyHint.narrow")
    expect(readyHintKey(false)).toBe("mango.status.readyHint")
  })

  test("it says so in both languages, without the top bar or the gear", async () => {
    const [{ dict: it }, { dict: en }] = await Promise.all([import("../i18n/it"), import("../i18n/en")])
    for (const text of [it["mango.status.readyHint.narrow"], en["mango.status.readyHint.narrow"]])
      expect(text).not.toMatch(/in alto|ingranaggio|at the top|gear/)
  })
})
