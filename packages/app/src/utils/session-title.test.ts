import { describe, expect, test } from "bun:test"
import { sessionTitle } from "./session-title"

describe("sessionTitle", () => {
  test("a real title is left alone", () => {
    expect(sessionTitle("Calculator", "New conversation")).toBe("Calculator")
  })

  test("the provisional English timestamp title becomes the given label", () => {
    expect(sessionTitle("New session - 2026-10-30T13:48:29.935Z", "New conversation")).toBe("New conversation")
    expect(sessionTitle("Child session - 2026-10-30T13:48:29.935Z", "New conversation")).toBe("New conversation")
  })

  test("no title is left to the caller", () => {
    expect(sessionTitle(undefined, "Nuova conversazione")).toBeUndefined()
  })
})
