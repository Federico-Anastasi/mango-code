import { expect, test } from "bun:test"
import { reason } from "../../src/tool/invalid"

const css = ":root { --accent: #2c3e50; }\\n".repeat(2000)

test("a call cut by the token limit says so in one sentence, without the text that was sent", () => {
  const cut = `{"filePath":"style.css","content":"${css}`
  const said = reason({ tool: "write", arguments: cut, error: `JSON parsing failed: Text: ${cut}`, limit: 16384 })
  expect(said).toContain("the answer ended before the call to `write` was complete")
  expect(said).toContain("at most 16384 tokens")
  expect(said).toContain("then add the rest with `edit`")
  expect(said.length).toBeLessThan(300)
  expect(reason({ tool: "bash", arguments: '{"command":"echo', error: "x" })).toContain("less text")
})

test("another mistake keeps the parser's message, shortened when it quotes the arguments", () => {
  expect(reason({ tool: "read", arguments: '{"limit":"ten"}', error: "limit: expected a number" })).toBe("limit: expected a number")
  const long = reason({ tool: "write", arguments: `{"content":"${css}"}`, error: `filePath is missing. Text: ${css} End of the message.` })
  expect(long).toStartWith("filePath is missing.")
  expect(long).toEndWith("End of the message.")
  expect(long.length).toBeLessThan(900)
})
