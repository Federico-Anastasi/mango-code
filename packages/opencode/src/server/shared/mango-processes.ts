import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { LeftRunning } from "@/tool/shell/left-running"
import { tr } from "@/util/mango-language"

// mango-code: the programs the shell tool left running in a conversation (see tool/shell/left-running.ts). The side
// panel of the conversation lists them (GET ?sessionID=) and stops one with what it started (POST /stop with
// { sessionID, pid, started }: `started` is the creation time the list gave, so a PID reused by another program is
// refused with 404). A process table that cannot be read, or a program that does not stop, is a 500 with the sentence.
export const PROCESSES_PATH = "/mango/processes"
export const PROCESSES_STOP_PATH = "/mango/processes/stop"

export function processesEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const sessionID = new URL(request.url, "http://localhost").searchParams.get("sessionID")
    if (!sessionID)
      return HttpServerResponse.jsonUnsafe({ error: tr("manca sessionID", "sessionID is missing") }, { status: 400 })
    const processes = yield* Effect.tryPromise(() => LeftRunning.list(sessionID)).pipe(logged, Effect.option)
    if (processes._tag === "None") return unreadable()
    return HttpServerResponse.jsonUnsafe({ processes: processes.value })
  })
}

export function processesStopEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const body = yield* request.json.pipe(Effect.option)
    const input = body._tag === "Some" ? stopInput(body.value) : undefined
    if (!input)
      return HttpServerResponse.jsonUnsafe(
        { error: tr("servono sessionID, pid e started", "sessionID, pid and started are needed") },
        { status: 400 },
      )
    const result = yield* Effect.tryPromise(() => LeftRunning.stop(input)).pipe(logged, Effect.option)
    if (result._tag === "None") return unreadable()
    if (result.value === "gone")
      return HttpServerResponse.jsonUnsafe(
        { error: tr("il programma non è più acceso", "the program is no longer running") },
        { status: 404 },
      )
    if (result.value === "failed")
      return HttpServerResponse.jsonUnsafe(
        { error: tr("il programma non si è fermato", "the program did not stop") },
        { status: 500 },
      )
    return HttpServerResponse.jsonUnsafe({ stopped: true })
  })
}

const logged = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(Effect.tapError((error) => Effect.logWarning("the process table could not be read", { error })))

function unreadable() {
  return HttpServerResponse.jsonUnsafe(
    {
      error: tr(
        "impossibile leggere i programmi accesi sul computer",
        "the programs running on the computer cannot be read",
      ),
    },
    { status: 500 },
  )
}

function stopInput(body: unknown) {
  if (!body || typeof body !== "object") return
  const value = body as Record<string, unknown>
  if (typeof value.sessionID !== "string" || typeof value.pid !== "number" || typeof value.started !== "number") return
  return { sessionID: value.sessionID, pid: value.pid, started: value.started }
}
