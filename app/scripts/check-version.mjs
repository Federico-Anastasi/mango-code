// Checks that the version of the app is the same everywhere it is written, and that a release can be made of it:
// tauri.conf.json, the version Cargo reads for the app (workspace Cargo.toml, with Cargo.lock up to date), the tag
// (v + version, when --tag is given) and the release notes with their "Changed since" list. Exits with 1 on any difference.
// Usage: node app/scripts/check-version.mjs [--tag v0.1.0]   (the release workflow runs it before anything else)
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { whatChanged } from "./update-manifest.mjs"

/** The differences between what the files say; empty when the version is the same everywhere. */
export function versionErrors({ tauri, cargo, tag, notes }) {
  const errors = []
  if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(tauri)) errors.push(`tauri.conf.json says "${tauri}": X.Y.Z or X.Y.Z-rc.N expected`)
  if (cargo !== tauri) errors.push(`tauri.conf.json says ${tauri}, Cargo.toml ${cargo}`)
  if (tag !== undefined && tag !== `v${tauri}`) errors.push(`the tag is ${tag}, the version v${tauri}`)
  if (notes) errors.push(notes)
  return errors
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const tauri = JSON.parse(fs.readFileSync(path.join(app, "src-tauri", "tauri.conf.json"), "utf8")).version
  // --locked: a Cargo.lock that does not match the manifests is an error, as in the build
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: app, encoding: "utf8", maxBuffer: 64 << 20 }))
  const cargo = metadata.packages.find((p) => p.name === "mango-code")?.version
  if (!cargo) throw new Error("cargo metadata does not list the package mango-code")

  const i = process.argv.indexOf("--tag")
  const tag = i > 0 ? process.argv[i + 1] : undefined
  const notesFile = path.join(app, "release-notes", `v${tauri}.md`)
  let notes
  if (!fs.existsSync(notesFile)) notes = `app/release-notes/v${tauri}.md is missing`
  else {
    try {
      whatChanged(fs.readFileSync(notesFile, "utf8"))
    } catch (e) {
      notes = `app/release-notes/v${tauri}.md: ${e.message}`
    }
  }

  const errors = versionErrors({ tauri, cargo, tag, notes })
  for (const e of errors) console.error(e)
  if (errors.length) process.exit(1)
  console.log(`version ${tauri}${tag ? `, tag ${tag}` : ""}`)
}
