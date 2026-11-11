import { mangoDesktopError } from "@/utils/mango-desktop"

/**
 * "Report a problem": what the page sends and where it goes. In the app's window it goes through the bridge; from the
 * phone it goes to the phone port (`/phone/report`), which hands it to the app on the computer; in a plain browser there
 * is nowhere to send it. The body is the one `report.rs` reads (see its top).
 */

export type ReportInput = { error?: string; note?: string; screenshot?: boolean; files?: File[] }
/** What a report may carry: the user's files together (bytes), whether files can be attached, whether the window can be photographed. */
export type ReportInfo = { maxBytes: number; attachments: boolean; screenshot: boolean }
/** Sent to Mango Code; or (a build without the address) the file on the Desktop and the issue opened on GitHub. */
export type ReportOutcome = { sent: boolean; file?: string }
export type ReportTarget = { info: ReportInfo; send(input: ReportInput): Promise<ReportOutcome> }

/** The length of the JSON header (4 bytes), the header, the files one after the other. */
export async function reportBody(input: ReportInput, page?: string) {
  const files = input.files ?? []
  const header = new TextEncoder().encode(
    JSON.stringify({
      error: input.error ?? null,
      note: input.note ?? null,
      page: page ?? null,
      screenshot: !!input.screenshot,
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
    }),
  )
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, header.length)
  return new Blob([length, header, ...files])
}

/** The phone's way: the page of the phone port. Its errors come with the sentence for the user. */
async function phoneTarget(): Promise<ReportTarget | undefined> {
  const info = await fetch("/phone/report", { headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
  if (typeof info?.maxBytes !== "number") return undefined
  return {
    info,
    async send(input) {
      const response = await fetch("/phone/report", { method: "POST", body: await reportBody(input) })
      const answer = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(answer?.error ?? response.statusText)
      return answer
    },
  }
}

async function findTarget(): Promise<ReportTarget | undefined> {
  const bridge = window.__MANGO_DESKTOP__
  if (!bridge) return phoneTarget()
  const info = await bridge.reportInfo().catch((cause: unknown) => {
    console.error("report info not read", mangoDesktopError(cause).message)
    return undefined
  })
  return info && { info, send: (input) => bridge.reportProblem(input) }
}

let found: ReportTarget | undefined
/** Where a report goes from this page. Only an answer is kept: a failed look (the phone's network dropped) is repeated by the next caller. */
export async function reportTarget() {
  return (found ??= await findTarget())
}

type Refusal = { kind: "file" | "total"; name: string; size: number }

/**
 * Adds files to the ones already chosen, within `maxBytes` for the whole. A file that is too large (`file`) or that
 * would take them over the limit (`total`, `size` is what they would weigh) is left out and the first one is reported:
 * the user is told, nothing is dropped silently. The same file twice counts once.
 */
export function addAttachments(current: File[], incoming: File[], maxBytes: number) {
  const files = [...current]
  let total = files.reduce((sum, file) => sum + file.size, 0)
  let refused: Refusal | undefined
  for (const file of incoming) {
    if (files.some((have) => have.name === file.name && have.size === file.size && have.lastModified === file.lastModified))
      continue
    if (file.size > maxBytes) {
      refused ??= { kind: "file", name: file.name, size: file.size }
    } else if (total + file.size > maxBytes) {
      refused ??= { kind: "total", name: file.name, size: total + file.size }
    } else {
      files.push(file)
      total += file.size
    }
  }
  return { files, refused }
}

/** A size as the app's messages write it: KB under a megabyte, MB with a decimal above. */
export function formatSize(bytes: number) {
  return bytes < 1_000_000 ? `${Math.round(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
}
