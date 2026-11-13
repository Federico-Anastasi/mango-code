import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { createConversationFind, drawnResults, rowText } from "@/pages/session/timeline/conversation-find"
import { TimelineRow } from "@/pages/session/timeline/timeline-row"

const parts: Record<string, Part[]> = {
  msg_0: [{ id: "prt_0", type: "text", messageID: "msg_0", text: "un gatto più vecchio" } as Part],
  msg_1: [{ id: "prt_u", type: "text", messageID: "msg_1", text: "Dove sta il Gatto?" } as Part],
  msg_2: [
    {
      id: "prt_a",
      type: "text",
      messageID: "msg_2",
      text: "Il **gatto** è sul [tetto](https://gatto.example), un gatto nero.",
    } as Part,
  ],
}
const user = (id: string) => new TimelineRow.UserMessage({ userMessageID: id, anchor: true })
const answer = new TimelineRow.AssistantPart({
  userMessageID: "msg_1",
  group: { key: "part:msg_2:prt_a", type: "part", ref: { messageID: "msg_2", partID: "prt_a" } },
  previousAssistantPart: false,
})
const text = (row: TimelineRow.TimelineRow) => rowText(row, (id) => parts[id] ?? [])
const press = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, cancelable: true, ...init })
const answerKey = "assistant-part:msg_1:part:msg_2:prt_a"

describe("search in the conversation", () => {
  test("Enter and Shift+Enter go round the results, Esc closes and gives the focus back", () => {
    createRoot((dispose) => {
      const [rows] = createSignal([user("msg_1"), answer])
      let closed = 0
      const find = createConversationFind({ rows, text, onClose: () => closed++ })
      find.open()
      find.setQuery("GATTO")
      // The address of the link is not text of the answer: one in the question, two in the answer.
      expect(find.count()).toBe(3)
      expect(find.current()).toEqual({ key: "user-message:msg_1", nth: 0 })

      find.onKeyDown(press("Enter"))
      expect(find.index()).toBe(1)
      find.onKeyDown(press("Enter"))
      find.onKeyDown(press("Enter"))
      expect(find.index()).toBe(0)
      find.onKeyDown(press("Enter", { shiftKey: true }))
      expect(find.current()).toEqual({ key: answerKey, nth: 1 })

      find.onKeyDown(press("Escape", { isComposing: true }))
      expect(find.opened()).toBe(true)
      const escape = press("Escape")
      find.onKeyDown(escape)
      expect(escape.defaultPrevented).toBe(true)
      expect(find.opened()).toBe(false)
      expect(closed).toBe(1)
      dispose()
    })
  })

  test("the current result stays the same place when older messages are loaded above", () => {
    createRoot((dispose) => {
      const [rows, setRows] = createSignal<TimelineRow.TimelineRow[]>([user("msg_1"), answer])
      const find = createConversationFind({ rows, text })
      find.open()
      find.setQuery("gatto")
      find.move(1)
      expect(find.current()).toEqual({ key: answerKey, nth: 0 })

      setRows([user("msg_0"), user("msg_1"), answer])
      expect(find.count()).toBe(4)
      expect(find.current()).toEqual({ key: answerKey, nth: 0 })
      expect(find.index()).toBe(2)
      dispose()
    })
  })

  test("a drawn row counts what it shows; a result that is not there gives way to the next one", () => {
    createRoot((dispose) => {
      const [rows] = createSignal([user("msg_1"), answer])
      const find = createConversationFind({ rows, text })
      find.open()
      find.setQuery("gatto")
      find.move(1)
      find.move(1)
      expect(find.current()).toEqual({ key: answerKey, nth: 1 })

      find.counted(answerKey, 1)
      expect(find.count()).toBe(2)
      // The answer shows one result only: the next one after it is the first of the conversation again.
      expect(find.current()).toEqual({ key: "user-message:msg_1", nth: 0 })
      dispose()
    })
  })

  test("the marks go on the drawn text only, without the comment cards", () => {
    try {
      document.body.innerHTML = `
        <div data-timeline-key="user-message:msg_1"><div data-slot="user-message-text">Il <b>Gat</b>to e il gatto
          <div data-slot="user-message-comments">gatto in un commento</div></div></div>
        <div data-timeline-key="${answerKey}"><div data-slot="text-part-body"><p>Il <strong>gatto</strong> è sul
          <a href="https://gatto.example">tetto</a></p></div><div data-slot="tool-title">gatto</div></div>`
      const drawn = drawnResults(document.body, "gatto")
      expect(drawn.map((row) => [row.key, row.ranges.map((range) => range.toString())])).toEqual([
        ["user-message:msg_1", ["Gatto", "gatto"]],
        [answerKey, ["gatto"]],
      ])
      expect(drawn[0].ranges[0].startContainer.textContent).toBe("Gat")
    } finally {
      document.body.innerHTML = ""
    }
  })
})
