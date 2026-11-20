import { describe, expect, test } from "bun:test"
import { folderKey } from "@/utils/path-key"
import { buildNotificationIndex } from "./notification"

const note = (directory: string, viewed = false, type: "turn-complete" | "error" = "turn-complete") =>
  ({ type, directory, session: `ses_${directory}`, time: 1, viewed }) as Parameters<typeof buildNotificationIndex>[0][number]

describe("the notifications of a project", () => {
  test("are one list for a folder however its path is written", () => {
    const index = buildNotificationIndex([note("C:\\Users\\X"), note("c:/users/x/", false, "error"), note("C:\\Users\\X", true), note("D:\\other")])
    expect(Object.keys(index.project.all).length).toBe(2)
    const project = folderKey("c:/users/x/")
    expect(index.project.all[project]?.length).toBe(3)
    expect(index.project.unseenCount[project]).toBe(2)
    expect(index.project.unseenHasError[project]).toBe(true)
  })

  test("keep the case of a path whose case may matter", () => {
    const index = buildNotificationIndex([note("/Repo"), note("/repo")])
    expect(Object.keys(index.project.all).sort()).toEqual(["/Repo", "/repo"])
  })
})
