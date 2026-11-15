// A small model writes the paths of the computers it was trained on: `/home/user/site/index.html`, `/tmp/out.log`. On
// Windows such a path names nothing the model meant: taken as it is, it lands in a new folder at the root of the drive
// and the project stays empty. It is taken from the project folder instead, and the result of the call says so. A path
// with a drive (`C:\...`, `D:\...`) is left alone, wherever it points: the model may work outside the project.

import path from "path"

// The folders a Unix path starts with that are not part of what the model is naming: `/home/<user>`, `/tmp`, ...
const UNIX_ROOTS = new Set(["home", "root", "tmp", "workspace", "workspaces", "app", "mnt", "var", "usr", "opt", "srv", "etc"])
// The folders at the root of a Windows drive that a path without a drive may really mean.
const WINDOWS_ROOTS = new Set(["users", "windows", "program files", "program files (x86)", "programdata"])

export type Located = {
  /** The absolute path on this computer. */
  path: string
  /** Set when the path written was a Unix one and was taken from the project folder: what to tell the model. */
  note?: string
}

const inside = (child: string, parent: string) => {
  const relative = path.win32.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
}

/** Where the path a model wrote is on this computer, given the project folder. */
export function locate(written: string, directory: string, platform: NodeJS.Platform = process.platform): Located {
  if (platform !== "win32") return { path: path.resolve(directory, written) }
  const plain = path.win32.resolve(directory, written)
  if (!/^[\\/](?![\\/])/.test(written)) return { path: plain }

  const parts = written.split(/[\\/]+/).filter(Boolean)
  // Git Bash writes a drive as a folder: /c/Users/name
  if (/^[A-Za-z]$/.test(parts[0] ?? "") && parts.length > 1) return { path: path.win32.join(`${parts[0].toUpperCase()}:\\`, ...parts.slice(1)) }
  if (inside(plain, directory) || WINDOWS_ROOTS.has((parts[0] ?? "").toLowerCase())) return { path: plain }

  const name = path.win32.basename(directory).toLowerCase()
  const named = parts.map((part) => part.toLowerCase()).lastIndexOf(name)
  const root = (parts[0] ?? "").toLowerCase()
  const skipped = named >= 0 ? named + 1 : root === "home" ? 2 : UNIX_ROOTS.has(root) ? 1 : 0
  const real = path.win32.join(directory, ...parts.slice(skipped))
  const shown = path.win32.relative(directory, real) || "."
  return {
    path: real,
    note: `\`${written}\` is not a path of this computer, which runs Windows: \`${shown}\` in the project folder (${directory}) was used instead. Write paths relative to the project folder.`,
  }
}

export * as ProjectPath from "./project-path"
