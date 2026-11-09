import { describe, expect, test } from "bun:test"
import type { HomeSessionGroup, HomeSessionRecord } from "./home-sessions-controller"
import { filterHomeGroups } from "./home-mobile-filter"

const record = (title: string, projectName: string) =>
  ({ session: { title }, project: {}, projectName }) as unknown as HomeSessionRecord

const groups: HomeSessionGroup[] = [
  { id: "today", title: "Oggi", sessions: [record("Il pulsante Accedi", "ricette-app"), record("", "sito")] },
  { id: "older", title: "Meno recenti", sessions: [record("Traduci i messaggi", "ricette-app")] },
]
const title = (value: string) => value || "Nuova conversazione"

describe("filterHomeGroups", () => {
  test("without a query everything stays", () => {
    expect(filterHomeGroups(groups, "  ", title)).toBe(groups)
  })

  test("it looks in the title and in the project name, whatever the case", () => {
    expect(filterHomeGroups(groups, "ACCEDI", title).map((group) => group.sessions.length)).toEqual([1])
    expect(filterHomeGroups(groups, "ricette", title).map((group) => group.id)).toEqual(["today", "older"])
  })

  test("an untitled conversation is found by the name it is shown with", () => {
    expect(filterHomeGroups(groups, "nuova conv", title)[0]?.sessions.map((r) => r.projectName)).toEqual(["sito"])
  })

  test("a group with no match is dropped", () => {
    expect(filterHomeGroups(groups, "traduci", title).map((group) => group.id)).toEqual(["older"])
    expect(filterHomeGroups(groups, "zzz", title)).toEqual([])
  })
})
