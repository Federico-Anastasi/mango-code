// mango-code: the model's working time in a session, for the web UI header.
// The page keeps in memory only the latest answers of a long conversation: the older
// steps are read from here, one by one, so the page discards them if it has already loaded them.

export type WorkStep = { id: string; ms: number }

type Row = { id: string; data: unknown }

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

/** Last instant recorded by a part (text, reasoning, tool): its end, or its start. */
export function partActivity(data: unknown) {
  const part = record(data)
  if (!part) return
  const time = record(part.type === "tool" ? record(part.state)?.time : part.time)
  return num(time?.end) ?? num(time?.start)
}

/** Assistant steps that did work; `partsOf` is only used for the ones left without an end. */
export function workSteps(messages: readonly Row[], partsOf: (messageID: string) => readonly unknown[]): WorkStep[] {
  const steps: WorkStep[] = []
  for (const message of messages) {
    const data = record(message.data)
    const time = record(data?.time)
    const created = num(time?.created)
    if (data?.role !== "assistant" || created === undefined) continue
    // An interrupted answer (button or app closed) counts up to its last activity.
    const end =
      num(time?.completed) ??
      partsOf(message.id).reduce<number | undefined>((latest, part) => {
        const moment = partActivity(part)
        return moment !== undefined && (latest === undefined || moment > latest) ? moment : latest
      }, undefined)
    if (end !== undefined && end > created) steps.push({ id: message.id, ms: end - created })
  }
  return steps
}
