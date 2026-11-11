import { dlopen, FFIType, read, type Pointer } from "bun:ffi"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// mango-code: folders too broad to be a project. A project is where the agent works, takes snapshots and makes a git
// repository: on the Desktop, in Documents, Downloads, the user's folder, a drive root or OneDrive it would swallow the
// files of the whole PC. The rule sits here, in the agent, so that the app, the phone and any other client share it
// (see shared/mango-project-folder.ts for the route the web UI asks, and project.ts, session.ts for where it holds).

// Folders that Windows lets the user move (OneDrive moves Desktop, Documents and Pictures into its own folder, with
// the names of the user's language): asked to the system, not guessed from the profile folder.
const KNOWN_FOLDERS = [
  "B4BFCC3A-DB2C-424C-B029-7FE99A87C641", // Desktop
  "FDD39AD0-238F-46AF-ADB4-6C85480369C7", // Documents
  "374DE290-123F-4565-9164-39C4925E467B", // Downloads
  "33E28130-4E1E-4676-835A-98395C3BC3BB", // Pictures
  "4BD8D571-6D19-48D3-BE97-422220080E43", // Music
  "18989B1D-99B5-455B-841C-AB7C74E4DDFC", // Videos
  "5E6C858F-0E22-4760-9AFE-EA3317B67173", // the user's folder
  "DFDF76A2-C82A-4D63-906A-5644AC457385", // Public
  "A52BBA46-E9E1-435F-B3D9-28DAA648C0F6", // OneDrive
]

function guid(text: string) {
  const hex = text.replaceAll("-", "")
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0)
  bytes.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4)
  bytes.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6)
  for (let i = 0; i < 8; i++) bytes[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16)
  return bytes
}

/** The folders the system names, as it names them; the ones a PC does not have (no OneDrive) are left out. */
function systemFolders() {
  if (process.platform !== "win32") return []
  const shell = dlopen("shell32.dll", {
    SHGetKnownFolderPath: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  })
  const memory = dlopen("ole32.dll", { CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void } })
  return KNOWN_FOLDERS.flatMap((id) => {
    const out = new BigUint64Array(1)
    if (shell.symbols.SHGetKnownFolderPath(guid(id), 0, null, out) !== 0) return []
    const pointer = Number(out[0]) as Pointer
    let text = ""
    for (let at = 0, unit = read.u16(pointer, 0); unit !== 0; unit = read.u16(pointer, (at += 2))) text += String.fromCharCode(unit)
    memory.symbols.CoTaskMemFree(pointer)
    return [text]
  })
}

/** Every folder that is too broad to be a project, besides the roots of the disks. */
export function broadFolders() {
  const home = os.homedir()
  const profile = fs.existsSync(home) ? fs.readdirSync(home, { withFileTypes: true }) : []
  return [
    ...systemFolders(),
    path.dirname(home),
    home,
    ...["Desktop", "Documents", "Downloads"].map((name) => path.join(home, name)),
    ...[process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].flatMap((item) => item ?? []),
    ...profile.filter((entry) => /^OneDrive( - .+)?$/i.test(entry.name)).map((entry) => path.join(home, entry.name)),
  ]
}

// The way two spellings of the same folder compare equal: real name on disk (short names, links), no
// trailing separator, no `\?\` prefix, one Unicode form, Windows does not tell capitals apart.
function key(directory: string) {
  const resolved = path.resolve(directory.replace(/^\\\\\?\\/, ""))
  const real = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved
  return real.normalize("NFC").toLowerCase()
}

/** True for a drive root, the user's folder, Desktop, Documents, Downloads and the like, OneDrive: not a project. */
export function isBroadFolder(directory: string, folders = broadFolders()) {
  const target = key(directory)
  return target === key(path.parse(path.resolve(directory)).root) || folders.some((folder) => key(folder) === target)
}

/** The app opens projects as git repositories (MANGO_PROJECTS_GIT); only there is a broad folder refused. */
export function refusesBroadFolder(directory: string) {
  return process.env.MANGO_PROJECTS_GIT === "1" && isBroadFolder(directory)
}
