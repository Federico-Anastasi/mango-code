// Writes latest.json, the file the app reads to know whether there is a newer version (src-tauri/src/updater.rs),
// next to the installer that build.ps1 made and signed. It goes into the GitHub release together with the
// installer: the app looks for it at releases/latest/download/latest.json.
//
// Usage: node scripts/update-manifest.mjs (--notes-file <release-notes/vX.Y.Z.md> | --notes "text") [--url <address of the installer>]
//   --notes-file: the "notes" of latest.json are the list under "**Changed since …**" of the release notes, as plain text.
//   --url: by default the asset of release v<version> of $GITHUB_REPOSITORY (the repo running the workflow),
//          where spaces become dots (Mango.Code_0.1.1_x64-setup.exe); another address only for a test before publishing.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The list under "**Changed since …**" of the release notes, one "- " line per item, without Markdown marks. */
export function whatChanged(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const start = lines.findIndex((line) => /^\*\*Changed since .+\*\*\s*$/.test(line))
  if (start < 0) throw new Error('the release notes have no "**Changed since …**" list')
  const items = []
  for (const line of lines.slice(start + 1)) {
    if (/^\*\*/.test(line)) break
    if (/^[-*] /.test(line)) items.push(line.replace(/^[-*] /, "- "))
    else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`
    else if (items.length) break
  }
  if (!items.length) throw new Error('the "**Changed since …**" list of the release notes is empty')
  return items.map((item) => item.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "")).join("\n")
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const nsis = path.join(app, "target", "release", "bundle", "nsis")
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }

  const installers = fs.readdirSync(nsis).filter((f) => f.endsWith("-setup.exe"))
  if (installers.length !== 1) throw new Error(`one installer expected in ${nsis}, found: ${installers.join(", ") || "none"}`)
  const installer = installers[0]
  // the version is the one the build was made with (it is in the installer's name), not necessarily tauri.conf.json's
  const version = installer.match(/_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)_x64-setup\.exe$/)?.[1]
  if (!version) throw new Error(`no version in the installer's name: ${installer}`)
  const sig = path.join(nsis, `${installer}.sig`)
  if (!fs.existsSync(sig)) throw new Error(`${sig} is missing: the installer is signed by build.ps1 -Phase Sign, which needs the signing key`)

  const notesFile = arg("notes-file")
  const notes = notesFile ? whatChanged(fs.readFileSync(notesFile, "utf8")) : arg("notes")
  if (!notes) throw new Error("--notes-file <release notes> or --notes <text> is required")

  const asset = installer.replaceAll(" ", ".")
  const url = arg("url") ?? `https://github.com/${process.env.GITHUB_REPOSITORY ?? "Federico-Anastasi/mango-code"}/releases/download/v${version}/${asset}`
  const manifest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": { signature: fs.readFileSync(sig, "utf8").trim(), url },
    },
  }
  const out = path.join(nsis, "latest.json")
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`${out}\n  version ${version}\n  ${url}`)
}
