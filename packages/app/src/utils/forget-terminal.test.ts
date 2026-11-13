import { afterEach, describe, expect, test } from "bun:test"
import { forgetTerminal } from "./forget-terminal"

afterEach(() => localStorage.clear())

describe("forgetTerminal", () => {
  test("deletes what the removed terminal saved and nothing else", () => {
    const kept = {
      "opencode.workspace.C--work-app.123.dat:workspace:prompt": "{}",
      "opencode.workspace.C--work-app.123.dat:session:ses_1:file-view": "{}",
      "C:/work/terminal/prompt.v2": "{}",
      "C:/work/terminal/file.v1": "{}",
      "opencode.settings.dat:defaultServerUrl": "http://127.0.0.1:4196",
    }
    const gone = [
      "opencode.workspace.C--work-app.123.dat:workspace:terminal",
      "opencode.workspace.C--work-app.123.dat:session:ses_1:terminal",
      "C:/work/app/terminal.v1",
      "C:/work/app/terminal/ses_abc.v1",
    ]
    Object.entries(kept).forEach(([key, value]) => localStorage.setItem(key, value))
    gone.forEach((key) => localStorage.setItem(key, "{}"))
    localStorage.setItem(
      "opencode.global.dat:layout",
      JSON.stringify({ sidebar: { opened: true }, terminal: { height: 280, opened: true } }),
    )
    localStorage.setItem("opencode.global.dat:broken:layout", "{not json")

    expect(forgetTerminal(localStorage)).toBe(5)

    gone.forEach((key) => expect(localStorage.getItem(key)).toBeNull())
    Object.entries(kept).forEach(([key, value]) => expect(localStorage.getItem(key)).toBe(value))
    expect(JSON.parse(localStorage.getItem("opencode.global.dat:layout")!)).toEqual({ sidebar: { opened: true } })
    expect(localStorage.getItem("opencode.global.dat:broken:layout")).toBe("{not json")
    expect(forgetTerminal(localStorage)).toBe(0)
  })
})
