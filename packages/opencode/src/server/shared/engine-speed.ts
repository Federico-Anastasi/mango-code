import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { engineWait, liveTimings, readingProgress } from "@/provider/engine-timings"
import { engineQueue, type EngineRequest } from "@/provider/engine-queue"
import { isDefaultTitle } from "@/session/session"

// mango-code: live engine speed for the web UI. The page polls this route while the model works; `live` is
// empty when the engine is not writing (the numbers of finished steps are on the messages). `reading` is there
// only while the engine re-reads the context before answering, and it is the only time the engine is queried:
// while writing, `live` is enough.
// `wait` says why a request in progress has no numbers yet: GPUs on loan or model loading.
// The engine serves one conversation at a time: `active` says which (the numbers above are its),
// `waiting` which ones wait their turn, in order. `title` is absent if the conversation has no real name
// yet (default title).
export const ENGINE_SPEED_PATH = "/mango/engine/speed"

export type EngineSessionRef = {
  sessionID: string
  requestSessionID: string
  title?: string
  directory?: string
  since: number
}

type SessionInfo = { title: string; directory: string }

export function describeQueue(
  queue: { active?: EngineRequest; waiting: EngineRequest[] },
  info: ReadonlyMap<string, SessionInfo>,
) {
  const ref = (request: EngineRequest): EngineSessionRef => {
    const session = info.get(request.sessionID)
    return {
      sessionID: request.sessionID,
      requestSessionID: request.requestSessionID,
      ...(session && session.title.trim() && !isDefaultTitle(session.title) ? { title: session.title } : {}),
      ...(session ? { directory: session.directory } : {}),
      since: request.since,
    }
  }
  return { active: queue.active ? ref(queue.active) : null, waiting: queue.waiting.map(ref) }
}

export function engineSpeedEffect(database: Database.Interface) {
  return Effect.gen(function* () {
    const queue = engineQueue()
    const ids = [queue.active, ...queue.waiting].flatMap((request) => (request ? [request.sessionID] : []))
    const info = new Map<string, SessionInfo>()
    if (ids.length > 0) {
      const rows = yield* database.db
        .select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory })
        .from(SessionTable)
        .where(inArray(SessionTable.id, ids as (typeof SessionTable.$inferSelect.id)[]))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) info.set(row.id, { title: row.title, directory: row.directory })
    }
    const live = liveTimings() ?? null
    const reading = live ? null : ((yield* Effect.promise(() => readingProgress())) ?? null)
    // A request in progress with no numbers and no prefill: maybe the engine waits for the GPUs or loads the model.
    const wait = queue.active && !live && !reading ? ((yield* Effect.promise(() => engineWait())) ?? null) : null
    return HttpServerResponse.jsonUnsafe({ live, reading, wait, ...describeQueue(queue, info) })
  })
}
