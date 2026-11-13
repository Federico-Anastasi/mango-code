import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useFilteredList } from "@opencode-ai/ui/hooks"

// The lists of the app (menus, pickers, the @ and / suggestions) move with the arrows only:
// Ctrl+N and Ctrl+P are not moves any more.
test("a list moves with the arrows and not with Ctrl+N or Ctrl+P", async () => {
  await createRoot(async (dispose) => {
    const list = useFilteredList({ items: ["a", "b", "c"], key: (item: string) => item })
    while (list.flat().length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    const press = (key: string, ctrlKey = false) => {
      const event = new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true })
      list.onKeyDown(event)
      return event.defaultPrevented
    }

    expect(list.active()).toBe("a")
    expect(press("n", true)).toBe(false)
    expect(list.active()).toBe("a")
    press("ArrowDown")
    expect(list.active()).toBe("b")
    expect(press("p", true)).toBe(false)
    expect(list.active()).toBe("b")
    press("ArrowUp")
    expect(list.active()).toBe("a")
    dispose()
  })
})
