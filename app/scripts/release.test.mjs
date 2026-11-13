// Tests of the release scripts: node --test app/scripts/release.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { versionErrors } from "./check-version.mjs"
import { whatChanged } from "./update-manifest.mjs"

const scripts = path.dirname(fileURLToPath(import.meta.url))
const app = path.dirname(scripts)

test("the notes of latest.json are the list of changes as plain text, not the first line of the file", () => {
  const markdown = [
    "First release. Windows 10 or 11, 64-bit only.",
    "",
    "**Install:** download the installer.",
    "",
    "**Changed since rc.4**",
    "- The **phone** app: `Ctrl+0` resets the zoom, see [the guide](https://example.com/guide).",
    "- A long item that",
    "  goes on the next line.",
    "",
    "**What to expect**",
    "- Not a change.",
  ].join("\r\n")
  assert.equal(whatChanged(markdown), "- The phone app: Ctrl+0 resets the zoom, see the guide.\n- A long item that goes on the next line.")
})

test("a list of changes in groups, each under its title, is taken whole", () => {
  const markdown = ["**Changed since 0.1.0**", "", "Starting the app", "- One.", "- Two.", "", "Settings", "- Three.", "", "**What to expect**", "- Not a change."].join("\n")
  assert.equal(whatChanged(markdown), "- One.\n- Two.\n- Three.")
})

test("release notes without a list of changes, or with an empty one, are an error", () => {
  assert.throws(() => whatChanged("First release.\n\n**What to expect**\n- Something.\n"), /no "\*\*Changed since/)
  assert.throws(() => whatChanged("**Changed since 0.1.0**\n\n**What to expect**\n- Something.\n"), /empty/)
})

test("the notes of the release in the repo give the text the manifest carries", () => {
  const notes = whatChanged(fs.readFileSync(path.join(app, "release-notes", "v0.1.0.md"), "utf8"))
  assert.match(notes, /^- Mango Code on your phone is a web app made for the phone/)
  assert.doesNotMatch(notes, /[`*]|Windows 10 or 11/)
})

test("the version is the same everywhere, the tag is v + version, the notes exist", () => {
  const same = { tauri: "0.1.2", cargo: "0.1.2", lock: "0.1.2", tag: "v0.1.2" }
  assert.deepEqual(versionErrors(same), [])
  assert.deepEqual(versionErrors({ ...same, tag: undefined }), [])
  assert.deepEqual(versionErrors({ tauri: "0.1.2-rc.1", cargo: "0.1.2-rc.1", lock: "0.1.2-rc.1", tag: "v0.1.2-rc.1" }), [])
  assert.match(versionErrors({ ...same, cargo: "0.1.1", lock: "0.1.1" })[0], /tauri\.conf\.json says 0\.1\.2, Cargo\.toml 0\.1\.1/)
  assert.match(versionErrors({ ...same, lock: "0.1.1" })[0], /Cargo\.toml says 0\.1\.2, Cargo\.lock 0\.1\.1/)
  assert.match(versionErrors({ ...same, lock: undefined })[0], /Cargo\.lock undefined/)
  assert.match(versionErrors({ ...same, tag: "v0.1.3" })[0], /the tag is v0\.1\.3, the version v0\.1\.2/)
  assert.match(versionErrors({ ...same, tag: "0.1.2" })[0], /the tag is 0\.1\.2/)
  assert.match(versionErrors({ ...same, notes: "app/release-notes/v0.1.2.md is missing" })[0], /missing/)
  assert.match(versionErrors({ tauri: "0.1", cargo: "0.1", lock: "0.1" })[0], /X\.Y\.Z/)
})

test("the repo as it is passes the check, and a tag that is not its version does not", () => {
  const run = (...args) => spawnSync("node", [path.join(scripts, "check-version.mjs"), ...args], { encoding: "utf8" })
  const version = JSON.parse(fs.readFileSync(path.join(app, "src-tauri", "tauri.conf.json"), "utf8")).version
  const ok = run("--tag", `v${version}`)
  assert.equal(ok.status, 0, ok.stderr)
  const wrong = run("--tag", "v9.9.9")
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /the tag is v9\.9\.9/)
})
