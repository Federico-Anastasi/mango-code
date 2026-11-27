import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { tr } from "@/util/mango-language"

// mango-code: the user turned the Team off in a conversation, removed the OpenRouter key, or the app restarts the agent.
// Everything the Team started stops at once: the manager's answers in progress, the dev and the cloud agents (which keep
// being billed while they work). The mango-team plugin owns them and registers `stop` here (same process).
//   POST /mango/team/stop  { sessionID? }  ->  { working }
// `sessionID`: the conversation whose Team is stopped; without it, every Team conversation's. `working` says whether
// something was working (the conversation then has a line that says the Team was stopped). A process that does not end is a
// 500 with the sentence.
export const TEAM_STOP_PATH = "/mango/team/stop"
export const TEAM_KEY = Symbol.for("mango.team")

type Team = { stop(only?: string): Promise<{ working: boolean; failed: number[] }> }

export function teamStopEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.option)
    const value = body._tag === "Some" && body.value && typeof body.value === "object" ? (body.value as Record<string, unknown>) : {}
    const sessionID = typeof value.sessionID === "string" ? value.sessionID : undefined
    const team = (globalThis as Record<symbol, unknown>)[TEAM_KEY] as Team | undefined
    if (!team) return HttpServerResponse.jsonUnsafe({ working: false })
    const result = yield* Effect.tryPromise({ try: () => team.stop(sessionID), catch: (e) => e }).pipe(
      Effect.tapError((error) => Effect.logWarning("the Team could not be stopped", { error })),
      Effect.option,
    )
    if (result._tag === "None" || result.value.failed.length > 0)
      return HttpServerResponse.jsonUnsafe(
        { error: tr("non sono riuscito a fermare il Team", "the Team could not be stopped") },
        { status: 500 },
      )
    return HttpServerResponse.jsonUnsafe({ working: result.value.working })
  })
}
