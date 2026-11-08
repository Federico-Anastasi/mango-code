import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { eq, inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { workSteps } from "@/session/work-time"
import { tr } from "@/util/mango-language"

// mango-code: duration of each model step in a session (see session/work-time.ts). The web UI asks for it
// once when the conversation opens: it counts the recent steps by itself, live.
export const SESSION_WORK_PATH = "/mango/session/work"

export function sessionWorkEffect(request: HttpServerRequest.HttpServerRequest, database: Database.Interface) {
  return Effect.gen(function* () {
    const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID")
    if (!sessionID) return HttpServerResponse.jsonUnsafe({ error: tr("manca sessionID", "sessionID is missing") }, { status: 400 })

    const { db } = database
    const rows = yield* db
      .select({ id: MessageTable.id, data: MessageTable.data })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID as typeof MessageTable.$inferSelect.session_id))
      .all()
      .pipe(Effect.orDie)

    // The parts are needed only for answers left without an end.
    const open = rows
      .filter((row) => {
        const data = row.data as { role?: string; time?: { completed?: number } }
        return data.role === "assistant" && typeof data.time?.completed !== "number"
      })
      .map((row) => row.id)
    const parts = new Map<string, unknown[]>()
    if (open.length > 0) {
      const partRows = yield* db
        .select({ messageID: PartTable.message_id, data: PartTable.data })
        .from(PartTable)
        .where(inArray(PartTable.message_id, open))
        .all()
        .pipe(Effect.orDie)
      for (const row of partRows) parts.set(row.messageID, [...(parts.get(row.messageID) ?? []), row.data])
    }

    return HttpServerResponse.jsonUnsafe({ steps: workSteps(rows, (id) => parts.get(id) ?? []) })
  })
}
