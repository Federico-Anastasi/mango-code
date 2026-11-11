import { describe, expect, test, vi } from "bun:test"
import { createRoot } from "solid-js"
import { createSoundPreviewController } from "./general-controller-behavior"

describe("settings v2 controllers", () => {
  test("debounces previews and stops owned audio on disposal", async () => {
    vi.useFakeTimers()
    try {
      const played: string[] = []
      const stopped: string[] = []
      const owned = createRoot((dispose) => ({
        dispose,
        preview: createSoundPreviewController(async (id) => {
          played.push(id ?? "")
          return () => stopped.push(id ?? "")
        }),
      }))

      owned.preview.play("first")
      vi.advanceTimersByTime(99)
      expect(played).toEqual([])

      owned.preview.play("second")
      vi.advanceTimersByTime(100)
      await Promise.resolve()
      expect(played).toEqual(["second"])

      owned.dispose()
      expect(stopped).toEqual(["second"])
    } finally {
      vi.useRealTimers()
    }
  })
})
