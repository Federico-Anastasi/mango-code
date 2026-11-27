import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { files, isUser, lastCalls } from "../../src/session/compacted"

const info = (id: string, role: "user" | "assistant") => ({ id, sessionID: "ses_1", role }) as unknown as SessionV1.Info

const user = (id: string, parts: Record<string, unknown>[]): SessionV1.WithParts => ({
  info: info(id, "user"),
  parts: parts.map((part, n) => ({ id: `${id}_${n}`, messageID: id, sessionID: "ses_1", ...part })) as SessionV1.Part[],
})

const call = (
  id: string,
  tool: string,
  input: Record<string, unknown>,
  extra: { status?: "completed" | "error"; metadata?: Record<string, unknown> } = {},
): SessionV1.WithParts => ({
  info: info(id, "assistant"),
  parts: [
    {
      id: `${id}_0`,
      messageID: id,
      sessionID: "ses_1",
      type: "tool",
      callID: `call_${id}`,
      tool,
      state:
        extra.status === "error"
          ? { status: "error", input, error: "failed", time: { start: 1, end: 2 } }
          : { status: "completed", input, output: "ok", title: tool, metadata: extra.metadata ?? {}, time: { start: 1, end: 2 } },
    },
  ] as SessionV1.Part[],
})

describe("compacted.isUser", () => {
  test("a message the loop or the harness wrote, or the request for a summary, is not the user's", () => {
    const text = (extra: Record<string, unknown>) => [{ type: "text", text: "x", ...extra }]
    expect(isUser(user("msg_1", text({})))).toBe(true)
    expect(isUser(user("msg_2", text({ synthetic: true, metadata: { resume: "length" } })))).toBe(false)
    expect(isUser(user("msg_3", text({ synthetic: true, metadata: { harness: { held: true } } })))).toBe(false)
    expect(isUser(user("msg_4", [{ type: "compaction", auto: true }]))).toBe(false)
    expect(isUser(call("msg_5", "read", {}))).toBe(false)
  })
})

describe("compacted.lastCalls", () => {
  test("the last answered reading of each skill and the last plan, each alone, in the order they were made", () => {
    const found = lastCalls([
      call("msg_1", "skill", { name: "testing" }),
      call("msg_2", "plan", { steps: ["old"] }),
      call("msg_3", "skill", { name: "debugging" }),
      call("msg_4", "skill", { name: "testing" }),
      call("msg_5", "skill", { name: "debugging" }, { status: "error" }),
      call("msg_6", "todowrite", { todos: [] }),
      call("msg_7", "terminal", { command: "ls" }),
    ])
    expect(found.map((item) => String(item.info.id))).toEqual(["msg_3", "msg_4", "msg_6"])
    expect(found.every((item) => item.parts.length === 1)).toBe(true)
  })
})

describe("compacted.files", () => {
  const project = "C:\\work\\demo"
  test("the files read and the files written, from the project folder with slashes, once each, in order", () => {
    const found = files(
      [
        call("msg_1", "read", { path: "src\\a.ts" }),
        call("msg_2", "read", { filePath: "C:\\work\\demo\\src\\b.ts" }),
        call("msg_3", "edit", { filePath: "c:/work/demo/src/a.ts" }),
        call("msg_4", "write", { path: "./notes.md" }),
        call("msg_5", "read", { path: "src/a.ts" }),
        call("msg_6", "edit", { path: "src/a.ts" }),
      ],
      project,
    )
    expect(found).toEqual({ read: ["src/a.ts", "src/b.ts"], changed: ["src/a.ts", "notes.md"] })
  })

  test("a folder is not a file, a call that failed is not counted, a command of the terminal does not count", () => {
    const found = files(
      [
        call("msg_1", "read", { path: "." }),
        call("msg_2", "read", { path: "src/" }),
        call("msg_3", "read", { filePath: "C:\\work\\demo\\docs" }, { metadata: { display: { type: "directory" } } }),
        call("msg_4", "read", { path: "gone.ts" }, { status: "error" }),
        call("msg_5", "terminal", { command: "echo x > y.txt" }),
      ],
      project,
    )
    expect(found).toEqual({ read: [], changed: [] })
  })
})
