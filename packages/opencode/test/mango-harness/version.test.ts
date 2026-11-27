// What the settings page switches off in a commands harness: a skill leaves the list of the prompt and cannot be
// opened, the project's instructions leave the prompt.
import { afterAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Harness } from "@/session/harness"
import { versionOf } from "@/mango-harness/version"

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "harness-version-"))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const project = path.join(ROOT, "orders")
fs.mkdirSync(project)
fs.writeFileSync(path.join(project, "CLAUDE.md"), "Prices in euro.\n")

test("with nothing switched off the prompt has every skill and the instructions", () => {
  const system = versionOf(Harness.definition("mango-harness-2"), { date: "Sun Nov 22 2026" }).system(project)
  expect(system).toContain("- `skill debugging`")
  expect(system).toEndWith("\n\nInstructions from: CLAUDE.md\nPrices in euro.")
})

test("a skill switched off is not in the list nor among the pages; the instructions switched off are not in the prompt", () => {
  const version = versionOf(Harness.definition("mango-harness-2"), {
    date: "Sun Nov 22 2026",
    off: { skills: ["debugging"], instructions: true },
  })
  const system = version.system(project)
  expect(system).not.toContain("`skill debugging`")
  expect(system).toContain("- `skill planning`")
  expect(system).not.toContain("Instructions from")
  expect(version.pages.has("debugging")).toBe(false)
  expect(version.pages.has("planning")).toBe(true)
})
