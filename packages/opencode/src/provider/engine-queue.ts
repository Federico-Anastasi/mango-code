// mango-code: the local engine has a single slot: one request at a time, the others wait their turn in the
// order they arrived. Here the server keeps track of which conversations have a request to the engine, so the
// page knows who the numbers of the speed route are for and who is waiting. Between one step and the next (a
// tool running) the conversation has no request: the engine is free for another.

export type EngineRequest = {
  /** The conversation the user sees: for a sub-agent, the one it started from. */
  sessionID: string
  /** The session that actually made the request (different only for sub-agents). */
  requestSessionID: string
  /** When the request was queued. */
  since: number
}

type Entry = EngineRequest & { id: number }

let entries: Entry[] = []
let counter = 0

/** Queues a request; the returned function removes it (end, error or cancellation of the stream). */
export function enqueueEngineRequest(
  sessionID: string,
  options: { parentSessionID?: string; now?: number } = {},
): () => void {
  const id = ++counter
  entries.push({
    id,
    sessionID: options.parentSessionID ?? sessionID,
    requestSessionID: sessionID,
    since: options.now ?? Date.now(),
  })
  return () => {
    entries = entries.filter((entry) => entry.id !== id)
  }
}

function publicRequest({ sessionID, requestSessionID, since }: Entry): EngineRequest {
  return { sessionID, requestSessionID, since }
}

/**
 * The request the engine is serving (the oldest) and, in order of arrival, the conversations that are
 * waiting. A conversation appears only once: if it has several requests at the same time (the title while
 * it answers) the first counts, and if it is the active one it is not also in the queue.
 */
export function engineQueue(): { active?: EngineRequest; waiting: EngineRequest[] } {
  const [first, ...rest] = entries
  if (!first) return { waiting: [] }
  const seen = new Set([first.sessionID])
  const waiting: EngineRequest[] = []
  for (const entry of rest) {
    if (seen.has(entry.sessionID)) continue
    seen.add(entry.sessionID)
    waiting.push(publicRequest(entry))
  }
  return { active: publicRequest(first), waiting }
}

/** Only for tests. */
export function resetEngineQueue() {
  entries = []
}
