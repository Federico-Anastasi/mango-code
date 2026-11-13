// Test of the installer's hooks: node --test app/src-tauri/windows/hooks.test.mjs
// Compiles hooks.test.nsi with Tauri's own makensis (the one `tauri build` downloads) and runs the macro that frees
// the space on a copy of the data folder made in a temporary folder: nothing of the installed app is touched.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const makensis = process.env.MAKENSIS ?? path.join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "makensis.exe")

test("freeing the space deletes models, engines and logs, and leaves conversations and settings", { skip: !fs.existsSync(makensis) && `no makensis at ${makensis} (set MAKENSIS)` }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mango-hooks-"))
  try {
    const exe = path.join(work, "uninstall-test.exe")
    const built = spawnSync(makensis, ["/V2", `/DOUT=${exe}`, path.join(here, "hooks.test.nsi")], { encoding: "utf8", windowsHide: true })
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`)

    const files = {
      "models/whisper/ggml-small.bin": "w",
      "models/model.gguf": "m",
      "engine/llama/llama-server.exe": "e",
      "slots/model.bin": "s",
      "memory/model/state": "k",
      "logs/agent.log": "l",
      "agent/data/opencode/opencode.db": "chat",
      "agent/config/c": "c",
      "settings.json": "{}",
      "choices.json": "{}",
      "user-models.json": "[]",
    }
    const data = path.join(work, "data")
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(data, name)), { recursive: true })
      fs.writeFileSync(path.join(data, name), text)
    }

    const ran = spawnSync(exe, ["/S"], { encoding: "utf8", windowsHide: true })
    assert.equal(ran.status, 0)

    const left = Object.keys(files).filter((name) => fs.existsSync(path.join(data, name)))
    assert.deepEqual(left, ["agent/data/opencode/opencode.db", "agent/config/c", "settings.json", "choices.json", "user-models.json"])
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
})
