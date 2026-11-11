import { afterAll, beforeAll, expect, test } from "bun:test"
import { dictationHint, dictationState, setDictationEnabled, showDictationHint } from "./dictation-state"
import type { MangoDictationState } from "./mango-desktop"

const original = window.__MANGO_DESKTOP__
const off: MangoDictationState = { enabled: false, status: "off", doneMb: 0, sizeMb: 465, error: null }
const calls: boolean[] = []

beforeAll(() => {
  window.__MANGO_DESKTOP__ = {
    dictation: {
      state: async () => off,
      setEnabled: async (enabled: boolean) => {
        calls.push(enabled)
        return { ...off, enabled, status: enabled ? "waiting" : "off" }
      },
    },
  } as unknown as typeof window.__MANGO_DESKTOP__
})
afterAll(() => {
  window.__MANGO_DESKTOP__ = original
})

test("it starts from the app's answer, follows its events and takes the state that turning it on returns", async () => {
  const state = dictationState()
  expect(state()).toBeUndefined()
  await Promise.resolve()
  expect(state()?.status).toBe("off")

  window.dispatchEvent(new CustomEvent("mango-dictation", { detail: { ...off, enabled: true, status: "downloading", doneMb: 120 } }))
  expect(state()).toMatchObject({ status: "downloading", doneMb: 120 })

  await setDictationEnabled(false)
  expect(calls).toEqual([false])
  expect(state()?.status).toBe("off")
})

test("the sentence the microphone leaves for the settings is there until it is cleared", () => {
  expect(dictationHint()).toBeUndefined()
  showDictationHint("La dettatura è spenta")
  expect(dictationHint()).toBe("La dettatura è spenta")
  showDictationHint(undefined)
  expect(dictationHint()).toBeUndefined()
})
