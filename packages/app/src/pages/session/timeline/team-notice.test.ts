import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { teamNotice } from "./team-notice"

const part = (text: string, team: Record<string, unknown>) => [{ id: "prt_1", type: "text", sessionID: "ses_1", messageID: "msg_1", text, metadata: { team } }] as Part[]

describe("the line of the Team", () => {
  test("it carries the message as the dev or the agent wrote it, without the label the plugin puts first", () => {
    expect(teamNotice(part("[DEV]\nThe file is there.\nIt has one line.", { kind: "report" }))).toMatchObject({
      kind: "report",
      text: "The file is there.\nIt has one line.",
    })
    expect(teamNotice(part("[AGENT 2]\nPrices checked.", { kind: "report", agent: "2" }))).toMatchObject({
      agent: "2",
      text: "Prices checked.",
    })
    expect(teamNotice(part("[DEV] (automatic: turn ended without ask_manager)\nI wrote it.", { kind: "automatic" }))).toMatchObject({
      kind: "automatic",
      text: "I wrote it.",
    })
  })

  test("the beginning is one line: the message on one row, cut with an ellipsis when it is long", () => {
    expect(teamNotice(part("[DEV]\nThe file is there.\n\n  It has one line.", { kind: "report" }))?.excerpt).toBe("The file is there. It has one line.")
    const long = teamNotice(part(`[DEV]\n${"word ".repeat(100)}`, { kind: "report" }))!
    expect(long.excerpt).toBe(`${"word ".repeat(23)}word…`)
    expect(long.text).toBe("word ".repeat(100).trim())
  })

  test("the beginning is plain text: the marks of Markdown the model wrote are not in it, the whole text keeps them", () => {
    const written = "## Done\n\n**The file** is there, see [the notes](https://example.com/notes) and `notes.md`.\n\n- first_item stays\n- *second* one\n1. third\n> quoted\n```ts\nconst a = 1\n```"
    const notice = teamNotice(part(`[DEV]\n${written}`, { kind: "report" }))!
    expect(notice.excerpt).toBe("Done The file is there, see the notes and notes.md. first_item stays second one third quoted const a = 1")
    expect(notice.text).toBe(written)
  })

  test("a message with nothing after the label has no text to open", () => {
    expect(teamNotice(part("[DEV]", { kind: "report" }))).toMatchObject({ text: "", excerpt: "" })
    expect(teamNotice(part("[DEV]\n  \n", { kind: "report" }))).toMatchObject({ text: "", excerpt: "" })
    expect(teamNotice(part("[TEAM] The user stopped the team.\nThe dev was stopped.", { kind: "stopped" }))).toMatchObject({ kind: "stopped", text: "", excerpt: "" })
  })
})
