import { describe, expect, test } from "bun:test"
import {
  isDirectoryMissingError,
  missingDirectoryIn,
  onMissingDirectory,
  reportMissingDirectory,
} from "./missing-directory"

describe("missing-directory", () => {
  test("recognizes the server message and extracts the path", () => {
    expect(missingDirectoryIn("Directory not found: C:/Users/Alice/Documents/Mango Code/Prova")).toBe(
      "C:/Users/Alice/Documents/Mango Code/Prova",
    )
    expect(missingDirectoryIn(undefined, "Cannot load")).toBeUndefined()
  })

  test("recognizes the client error", () => {
    const err = new Error("x", { cause: { status: 404, body: { name: "DirectoryNotFound" } } })
    expect(isDirectoryMissingError(err)).toBe(true)
    expect(isDirectoryMissingError(new Error("x", { cause: { status: 404, body: { name: "Other" } } }))).toBe(false)
    expect(isDirectoryMissingError(undefined)).toBe(false)
  })

  test("notifies the listeners while they are subscribed", () => {
    const seen: string[] = []
    const off = onMissingDirectory((directory) => seen.push(directory))
    reportMissingDirectory("a")
    off()
    reportMissingDirectory("b")
    expect(seen).toEqual(["a"])
  })
})
