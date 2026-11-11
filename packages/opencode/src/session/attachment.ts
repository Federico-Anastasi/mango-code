// The user's attachments: copied into the project's `Attachments` folder, so the agent can use
// them as files (a logo in a page, a document to read again) even when the model
// cannot read them directly.
import fs from "fs/promises"
import path from "path"

export const ATTACHMENT_DIR = "Attachments"

/** Above this size (bytes) an attachment is saved but not converted to text. */
export const MAX_ATTACHMENT_CONVERT_BYTES = 25 * 1024 * 1024

export function safeName(filename: string | undefined) {
  const base = path.basename((filename ?? "").replace(/\\/g, "/")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
  const name = base.trim().replace(/^\.+/, "").replace(/[. ]+$/, "").slice(0, 120)
  if (!name) return "attachment"
  // opening nul.txt or con.pdf on Windows opens the device, not a file
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.split(".")[0]) ? `_${name}` : name
}

/**
 * Saves the bytes in `<project>/Attachments/<name>` and returns the path. A file with the same name
 * and identical content is reused; with different content a number is added to the name.
 */
export async function saveAttachment(directory: string, filename: string | undefined, bytes: Uint8Array) {
  const dir = path.join(directory, ATTACHMENT_DIR)
  await fs.mkdir(dir, { recursive: true })
  const name = safeName(filename)
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const target = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
    try {
      await fs.writeFile(target, bytes, { flag: "wx" })
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Buffer.from(bytes).equals(await fs.readFile(target))) return target
    }
  }
}
