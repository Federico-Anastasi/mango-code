// Writes latest.json, the file the app reads to know whether there is a newer version (src-tauri/src/updater.rs),
// next to the installer that build.ps1 made and signed. It goes into the GitHub release together with the
// installer: the app looks for it at releases/latest/download/latest.json.
//
// Usage: node scripts/update-manifest.mjs [--notes "text"] [--url <address of the installer>]
//   --url: by default the asset of release v<version> on GitHub, where spaces become dots
//          (Mango.Code_0.1.1_x64-setup.exe); another address only for a test before publishing.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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
if (!fs.existsSync(sig)) throw new Error(`${sig} is missing: build.ps1 signs only when it has the signing key`)

const asset = installer.replaceAll(" ", ".")
const url = arg("url") ?? `https://github.com/Federico-Anastasi/mango-code/releases/download/v${version}/${asset}`
const manifest = {
  version,
  notes: arg("notes") ?? `Mango Code ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature: fs.readFileSync(sig, "utf8").trim(), url },
  },
}
const out = path.join(nsis, "latest.json")
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")
console.log(`${out}\n  version ${version}\n  ${url}`)
