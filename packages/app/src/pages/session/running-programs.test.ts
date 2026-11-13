import { describe, expect, test } from "bun:test"
import { parseRunning, type RunningProgram } from "./running-programs"

const program: RunningProgram = {
  pid: 4321,
  started: 1_700_000_000_000,
  name: "bun.exe",
  command: "bun.exe index.html",
  asked: "Start-Process bun",
}

describe("parseRunning", () => {
  test("keeps the programs the agent lists and drops what has another shape", () => {
    expect(parseRunning({ processes: [program, { pid: "4322", started: 1 }, { pid: 4323 }, null] })).toEqual([program])
    expect(parseRunning({ processes: [] })).toEqual([])
    // an answer of another shape says nothing about the programs
    expect(parseRunning(undefined)).toBeUndefined()
    expect(parseRunning({ error: "sessionID is missing" })).toBeUndefined()
  })
})
