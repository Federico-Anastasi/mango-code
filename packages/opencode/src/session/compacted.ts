// mango-code: the conversation the model reads once it has been summarised. The messages stay in the database as they
// were; this is how they are put together for the next request, from what the summary stored (`CompactionPart`):
//   the first message of the user, a line saying how many are left out, the latest ones that fit, the last reading of
//   each skill and the last state of the plan, the summary (written by the agent after the model's), and the last
//   messages from where the tail begins. Nothing is cut out of the old part: the request is always the same until the
//   next summary.
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type Message = SessionV1.WithParts
type Written = "summary" | "missing"

/** The tools whose last answer comes back after a summary: a skill by its name, the plan (Mango Harness 2) or the task
 *  list (Mango Harness 1). */
const SKILL = "skill"
const PLAN = new Set(["plan", "todowrite"])

/** A message the loop writes to take up the turn, not a turn of the user (a synthetic text marked `resume`). */
export const isResume = (message: Message) =>
  message.info.role === "user" && message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.resume)

export const compactionPart = (message: Message) =>
  message.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

/** A message the harness wrote where the user's would be: an answer it held back, asked again. */
const isHeld = (message: Message) =>
  message.parts.some((part) => part.type === "text" && part.synthetic && part.metadata?.harness?.held === true)

/** A message of the user, as the summary keeps them: not the one that asks for a summary, not one the loop wrote. */
export const isUser = (message: Message) =>
  message.info.role === "user" && !compactionPart(message) && !isResume(message) && !isHeld(message)

/** What the message the agent writes after a summary holds in this part, if it is one of its parts. */
const writtenBy = (part: SessionV1.Part): Written | undefined =>
  part.type === "text" && part.synthetic && part.metadata?.resume === "compaction"
    ? (part.metadata.compaction as Written | undefined)
    : undefined

export const written = (message: Message) =>
  message.info.role === "user" ? message.parts.some((part) => writtenBy(part) !== undefined) : false

/** The summary of the model: an answer that finished without an error. */
export const isSummary = (message: Message) =>
  message.info.role === "assistant" && message.info.summary === true && !!message.info.finish && !message.info.error

const only = (message: Message, which: Written): Message => ({
  info: message.info,
  parts: message.parts.filter((part) => writtenBy(part) === which),
})

const toolKey = (part: SessionV1.ToolPart) => {
  if (part.tool === SKILL) {
    const name = (part.state.input as { name?: unknown }).name
    return typeof name === "string" ? `${SKILL} ${name}` : undefined
  }
  return PLAN.has(part.tool) ? "plan" : undefined
}

/** The last answered call of each skill and of the plan among `messages`, each alone in a message of the model's, in the
 *  order they were made. */
export function lastCalls(messages: Message[]): Message[] {
  const last = new Map<string, { at: number; message: Message; part: SessionV1.ToolPart }>()
  messages.forEach((message, at) => {
    if (message.info.role !== "assistant") return
    message.parts.forEach((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return
      const key = toolKey(part)
      if (key !== undefined) last.set(key, { at, message, part })
    })
  })
  return [...last.values()]
    .toSorted((a, b) => a.at - b.at || a.part.id.localeCompare(b.part.id))
    .map((one) => ({ info: one.message.info, parts: [one.part] }))
}

/** The conversation from the latest summary on, or `all` (oldest first) when there is none. */
export function rebuild(all: Message[]): Message[] {
  const at = all.findLastIndex(isSummary)
  if (at < 0) return all
  const summary = all[at]!
  const asked = all.findIndex((message) => message.info.id === (summary.info as SessionV1.Assistant).parentID)
  const part = asked < 0 ? undefined : compactionPart(all[asked]!)
  if (asked < 0 || !part) return all
  const start = part.tail_start_id ? all.findIndex((message) => message.info.id === part.tail_start_id) : -1
  const tail = start >= 0 && start < asked ? all.slice(start, asked) : []
  const told = all.findIndex((message, index) => index > at && written(message))
  const after = all.filter((_, index) => index > at && index !== told)
  const request = all[asked]!

  // A session summarised before the agent wrote its own message holds only the summary and the last messages.
  if (told < 0) {
    const text = summary.parts.find((one) => one.type === "text")
    const said: Message[] = text ? [{ info: request.info, parts: [{ ...text, messageID: request.info.id }] }] : []
    return [...said, ...tail, request, summary, ...after]
  }

  const before = all.slice(0, start >= 0 ? start : asked)
  const users = before.filter(isUser)
  const from = part.users_from_id ? users.findIndex((message) => message.info.id === part.users_from_id) : -1
  const latest = from > 0 ? users.slice(from) : []
  const note = only(all[told]!, "missing")
  return [
    ...users.slice(0, 1),
    ...(note.parts.length && users[0] ? [{ info: users[0].info, parts: note.parts }] : []),
    ...latest,
    ...lastCalls(before),
    only(all[told]!, "summary"),
    ...tail,
    request,
    summary,
    ...after,
  ]
}

/** The files read, and the files written or edited, in the whole conversation: from the project folder, with `/`, in
 *  the order they first appear. A folder read is not a file. */
export function files(messages: Message[], project: string) {
  const inProject = (file: string) => {
    const same = file.replaceAll("\\", "/").replace(/^\.\//, "")
    const root = project.replaceAll("\\", "/").replace(/\/$/, "")
    return same.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? same.slice(root.length + 1) : same
  }
  const found = messages.flatMap((message) =>
    message.info.role !== "assistant"
      ? []
      : message.parts.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "completed") return []
          const input = part.state.input as { path?: unknown; filePath?: unknown }
          const given = typeof input.path === "string" ? input.path : input.filePath
          if (typeof given !== "string" || !["read", "write", "edit"].includes(part.tool)) return []
          const file = inProject(given)
          if (part.tool === "read" && (/^\.?\/?$|\/$/.test(file) || part.state.metadata?.display?.type === "directory")) return []
          return [{ tool: part.tool, file }]
        }),
  )
  const unique = (tools: string[]) => [...new Set(found.filter((one) => tools.includes(one.tool)).map((one) => one.file))]
  return { read: unique(["read"]), changed: unique(["write", "edit"]) }
}
