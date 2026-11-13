import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { findMatches, plainText, rowText, textRanges } from "./conversation-find"
import { TimelineRow } from "./timeline-row"

const answer = `## Il **gatto** di casa

Vedi [la pagina del gatto](https://example.com/gatto) e \`gatto.ts\`.

\`\`\`gatto
const nome = "gatto"
\`\`\`

| animale | nome |
| --- | :---: |
| gatto | *Micio* |

- un _gatto_ nero
> il gatto_che_dorme`

const parts: Record<string, Part[]> = {
  msg_1: [
    { id: "prt_u", type: "text", messageID: "msg_1", text: "Dove sta il **gatto**?" } as Part,
    { id: "prt_c", type: "text", messageID: "msg_1", text: "commento sul gatto", synthetic: true } as Part,
  ],
  msg_2: [
    { id: "prt_a", type: "text", messageID: "msg_2", text: answer } as Part,
    { id: "prt_t", type: "tool", messageID: "msg_2", tool: "read" } as Part,
  ],
}
const getParts = (id: string) => parts[id] ?? []
const assistantRow = (partID: string) =>
  new TimelineRow.AssistantPart({
    userMessageID: "msg_1",
    group: { key: `part:msg_2:${partID}`, type: "part", ref: { messageID: "msg_2", partID } },
    previousAssistantPart: false,
  })
const rows = [
  new TimelineRow.UserMessage({ userMessageID: "msg_1", anchor: true }),
  assistantRow("prt_a"),
  assistantRow("prt_t"),
  new TimelineRow.TurnStats({ userMessageID: "msg_1" }),
]
const text = (row: TimelineRow.TimelineRow) => rowText(row, getParts)

describe("search in the conversation", () => {
  test("reads an answer as the chat draws it: no markers, no addresses, no first line of a code block", () => {
    expect(plainText(answer).replace(/\s+/g, " ").trim()).toBe(
      'Il gatto di casa Vedi la pagina del gatto e gatto.ts. const nome = "gatto" animale nome gatto Micio un gatto nero il gatto_che_dorme',
    )
  })

  test("finds the text in what the user wrote and in what the model answered, in reading order", () => {
    const found = findMatches(rows, "gatto", text)
    // The user's text is drawn as written; the comment (a card of its own) and the tool are not searched.
    expect(found.filter((item) => item.key === "user-message:msg_1")).toEqual([{ key: "user-message:msg_1", nth: 0 }])
    expect(found.filter((item) => item.key === "assistant-part:msg_1:part:msg_2:prt_a")).toHaveLength(7)
    expect(findMatches(rows, "example.com", text)).toEqual([])
    expect(findMatches(rows, "read", text)).toEqual([])
    expect(findMatches(rows, "", text)).toEqual([])
  })

  test("a drawn row is counted on what it shows", () => {
    const found = findMatches(rows, "gatto", text, (key) => (key === "user-message:msg_1" ? 3 : undefined))
    expect(found.filter((item) => item.key === "user-message:msg_1").map((item) => item.nth)).toEqual([0, 1, 2])
  })

  test("marks the places in the drawn messages, across the pieces of the text", () => {
    try {
      document.body.innerHTML = `
        <div data-slot="user-message-text">Il <b>Gat</b>to <i>e</i> il ga<b>t</b>to</div>
        <div data-slot="tool-title">gatto</div>
        <div data-slot="text-part-body"><p>niente</p></div>
        <div data-slot="text-part-body"><p>gatto</p></div>`
      const ranges = textRanges(document.body, "gatto")
      expect(ranges.map((range) => range.toString())).toEqual(["Gatto", "gatto", "gatto"])
      expect(ranges[0].startContainer.textContent).toBe("Gat")
      expect(ranges[0].endContainer.textContent).toBe("to ")
      expect(ranges[1].startContainer.textContent).toBe(" il ga")
      expect(ranges[1].endContainer.textContent).toBe("to")
    } finally {
      document.body.innerHTML = ""
    }
  })
})
