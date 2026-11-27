// A small model writes the paths of the computers it was trained on: `/home/user/site/index.html`, `/tmp/out.log`. On
// Windows such a path names nothing the model meant: taken as it is, it lands in a new folder at the root of the drive
// and the project stays empty. It is taken from the project folder instead, and the result of the call says so. A path
// with a drive (`C:\...`, `D:\...`) is left alone, wherever it points: the model may work outside the project.

import fs from "fs"
import path from "path"
import { fromLinux } from "../../../../launcher/mango-linux-path.mjs"

export type Located = {
  /** The absolute path on this computer. */
  path: string
  /** Set when the path written was a Unix one and was taken from the project folder: what to tell the model. */
  note?: string
}

/** Where the path a model wrote is on this computer, given the project folder (`launcher/mango-linux-path.mjs`). */
export function locate(written: string, directory: string, platform: NodeJS.Platform = process.platform): Located {
  if (platform !== "win32") return { path: path.resolve(directory, written) }
  // a stat only for a path written for Linux that is not in the project: a rare case of a call
  const at = fromLinux(directory, written, (name) => fs.existsSync(path.win32.join(directory, name)))
  if (!at) return { path: path.win32.resolve(directory, written) }
  if (!at.moved) return { path: at.path }
  const shown = path.win32.relative(directory, at.path) || "."
  return {
    path: at.path,
    note: `\`${written}\` is not a path of this computer, which runs Windows: \`${shown}\` in the project folder (${directory}) was used instead. Write paths relative to the project folder.`,
  }
}

export * as ProjectPath from "./project-path"
