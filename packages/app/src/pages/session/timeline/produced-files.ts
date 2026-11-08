import type { Part } from "@opencode-ai/sdk/v2"
import {
  producedFilePath,
  projectFilePath,
  projectRelativePath,
  samePathKey,
} from "@opencode-ai/session-ui/project-file"
import type { SummaryDiff } from "./timeline-row"

/** Paths of the files that the turn's tools say they wrote, without duplicates. */
export function producedFiles(parts: Part[]) {
  const seen = new Set<string>()
  return parts.flatMap((part) => {
    if (part.type !== "tool" || part.state.status !== "completed") return []
    const path = producedFilePath(part.tool, part.state.input, part.state.output)
    if (!path || seen.has(samePathKey(path))) return []
    seen.add(samePathKey(path))
    return [path]
  })
}

export type SummaryFile = { file: string; path: string; diff?: SummaryDiff }

/**
 * The files of the turn: those recorded by git (with the changed lines) plus those written by the
 * tools. In a folder without git the changes are not recorded, and without the latter a newly
 * created document would not appear in the chat.
 */
export function summaryFiles(diffs: SummaryDiff[], produced: string[], directory: string): SummaryFile[] {
  const files: SummaryFile[] = diffs.map((diff) => ({ file: diff.file, path: projectFilePath(directory, diff.file), diff }))
  const seen = new Set(files.map((item) => samePathKey(item.path)))
  for (const path of produced) {
    if (seen.has(samePathKey(path))) continue
    seen.add(samePathKey(path))
    files.push({ file: projectRelativePath(directory, path), path })
  }
  return files
}
