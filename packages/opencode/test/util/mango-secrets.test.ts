import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "../../src/mango-harness/terminal"
import { withoutKeys } from "../../src/util/mango-secrets"

const KEYS = { MANGO_SERVER_KEY_SERVER_3: "sk-invented", MANGO_ENGINE_KEY: "engine-invented", MANGO_OPENROUTER_KEY: "or-invented" }

test("the keys are taken out, the rest of the environment stays", () => {
  expect(withoutKeys({ ...KEYS, MANGO_OTHER: "kept", PATH: "p" })).toEqual({ MANGO_OTHER: "kept", PATH: "p" })
  expect(withoutKeys({ mango_server_key_server_1: "lower" })).toEqual({})
})

test("a command of the model does not see the keys the agent holds", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "mango-secrets-"))
  try {
    const ran = await run({ command: "env", cwd: folder, seconds: 30, shell: "bash", env: { ...process.env, ...KEYS, MANGO_OTHER: "kept" } })
    expect(ran.code).toBe(0)
    expect(ran.text).toContain("MANGO_OTHER=kept")
    for (const value of Object.values(KEYS)) expect(ran.text).not.toContain(value)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
