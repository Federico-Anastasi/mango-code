import { expect, test } from "bun:test"
import { isTrustedOrigin } from "../../src/server/routes/instance/httpapi/middleware/origin-guard"

test("only the web UI of the same server, the app and whoever sends no Origin", () => {
  expect(isTrustedOrigin(undefined, "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("http://127.0.0.1:4096", "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("tauri://localhost", "127.0.0.1:4096")).toBe(true)
  expect(isTrustedOrigin("https://foreign-site.example", "127.0.0.1:4096")).toBe(false)
  // another local port: the dev server of a project
  expect(isTrustedOrigin("http://localhost:3000", "127.0.0.1:4096")).toBe(false)
  expect(isTrustedOrigin("http://127.0.0.1:5173", "127.0.0.1:4096")).toBe(false)
  expect(isTrustedOrigin("null", "127.0.0.1:4096")).toBe(false)
})
