// Mango Code is updated by its app, never by opencode: no command, dialog or hint may offer to
// install or replace the agent from inside it.
import { describe, expect } from "bun:test"
import { test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

const read = (file: string) => Bun.file(path.resolve(import.meta.dir, "../../", file)).text()

describe("no way to upgrade the agent from inside it", () => {
  cliIt.live(
    "the upgrade command is not part of the CLI",
    ({ opencode }) =>
      Effect.gen(function* () {
        const help = yield* opencode.spawn(["--help"], { env: { COLUMNS: "120" } })
        expect(help.stderr).not.toMatch(/\bupgrade\b/)
        const upgrade = yield* opencode.spawn(["upgrade", "--major"], { env: { COLUMNS: "120" } })
        expect(upgrade.exitCode).not.toBe(0)
        expect(upgrade.stdout + upgrade.stderr).not.toContain("OpenCode 2")
      }),
    60_000,
  )

  test("the terminal interface gets no updater, so /update is not offered", async () => {
    expect(await read("src/cli/cmd/tui.ts")).not.toMatch(/updater|upgradeMajor|Installation\.upgrade/)
  })

  test("the tips do not suggest running upgrade", async () => {
    expect(await read("../tui/src/feature-plugins/home/tips-view.tsx")).not.toContain("opencode upgrade")
  })
})
