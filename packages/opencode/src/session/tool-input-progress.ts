// mango-code: progress of a tool while the model dictates its parameters. A long file write takes
// minutes and the JSON of the parameters arrives in pieces: from the partial one we read how much
// has been written so far and, as soon as it appears, the file.

export type ToolInputProgress = {
  /** Characters of the parameters JSON received so far. */
  chars: number
  /** Lines of text written so far (line breaks inside the JSON strings, plus the current line). */
  lines: number
  /** Path of the file, as soon as its string is complete. */
  file?: string
}

const FILE_KEY = /"(?:filePath|file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/

export function toolInputProgress(partialJson: string): ToolInputProgress {
  const breaks = partialJson.split("\\n").length - 1
  const progress: ToolInputProgress = {
    chars: partialJson.length,
    lines: partialJson.length === 0 ? 0 : breaks + 1,
  }
  const match = FILE_KEY.exec(partialJson)
  if (match) {
    try {
      const file = JSON.parse(`"${match[1]}"`)
      if (typeof file === "string" && file) progress.file = file
    } catch {
      // Truncated or invalid escape sequence: the file will be read at the next update.
    }
  }
  return progress
}
