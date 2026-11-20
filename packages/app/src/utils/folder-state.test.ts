import { describe, expect, test } from "bun:test"
import { moveToKept } from "./folder-state"
import { pathKey } from "./path-key"

describe("moveToKept", () => {
  test("moves what a record holds under another spelling of a folder to the spelling that stays", () => {
    const order = { "c:/work/site": ["a"], "D:\\other": ["b"], "/Repo": ["c"] }
    expect(moveToKept(order, ["C:\\Work\\Site", "D:\\other", "/Repo"])).toEqual({
      "D:\\other": ["b"],
      "/Repo": ["c"],
      "C:\\Work\\Site": ["a"],
    })
  })

  test("an entry that is already under the spelling that stays wins, and the other is dropped", () => {
    expect(moveToKept({ "C:\\x": 1, "c:/X/": 2 }, ["C:\\x"])).toEqual({ "C:\\x": 1 })
  })

  test("a folder that is not kept, a case that matters (a Linux path), and a record in order are left alone", () => {
    expect(moveToKept({ "c:/other": 1 }, ["C:\\x"])).toBeUndefined()
    expect(moveToKept({ "/repo": 1 }, ["/Repo"])).toBeUndefined()
    expect(moveToKept({ "C:\\x": 1 }, ["C:\\x"])).toBeUndefined()
    expect(moveToKept({}, ["C:\\x"])).toBeUndefined()
  })

  test("a record keyed the way pathKey writes it gets the key of the kept spelling", () => {
    expect(moveToKept({ "c:/work": "name" }, ["C:\\Work"], pathKey)).toEqual({ "C:/Work": "name" })
  })
})
