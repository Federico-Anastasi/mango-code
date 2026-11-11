// Tests of the list of Rust crates: node --test app/scripts/third-party.test.mjs
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { linkedCrates, render } from "./third-party.mjs"

const scripts = path.dirname(fileURLToPath(import.meta.url))

const pkg = (name, license = "MIT") => ({ id: name, name, version: "1.0.0", license, repository: null })
const metadata = (packages, deps) => ({
  packages,
  workspace_members: ["app"],
  resolve: { nodes: [{ id: "app", deps }, ...packages.filter((p) => p.id !== "app").map((p) => ({ id: p.id, deps: [] }))] },
})
const dep = (pkg, kind) => ({ pkg, dep_kinds: [{ kind }] })

test("the licenses of the crates cover what is linked, not what only tests or builds", () => {
  const m = metadata([pkg("app"), pkg("linked"), pkg("only-tests"), pkg("only-build")], [dep("linked", null), dep("only-tests", "dev"), dep("only-build", "build")])
  assert.deepEqual(linkedCrates(m).map((c) => c.name), ["linked"])
  assert.match(render(linkedCrates(m)), /\| linked \| 1\.0\.0 \| MIT \| <https:\/\/crates\.io\/crates\/linked> \|/)
})

test("a crate with no license, or only a GPL one, stops the list: it needs a decision", () => {
  assert.throws(() => linkedCrates(metadata([pkg("app"), pkg("nolicense", null)], [dep("nolicense", null)])), /declares no license/)
  assert.throws(() => linkedCrates(metadata([pkg("app"), pkg("copyleft", "GPL-3.0-only")], [dep("copyleft", null)])), /needs a decision/)
  assert.deepEqual(linkedCrates(metadata([pkg("app"), pkg("either", "GPL-2.0-only OR MIT")], [dep("either", null)])).map((c) => c.name), ["either"])
})

test("LICENSES/rust-crates.md is what Cargo.lock gives today", () => {
  const check = spawnSync("node", [path.join(scripts, "third-party.mjs"), "--check"], { encoding: "utf8" })
  assert.equal(check.status, 0, check.stderr)
})
