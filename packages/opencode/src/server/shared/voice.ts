import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { tr } from "@/util/mango-language"

// mango-code: dictation of the web UI. The microphone button records in the browser and sends the clip here;
// this route forwards it to the local transcription service (the app's `voice` crate), which the app starts
// next to the server and announces in MANGO_VOICE_URL. This way the page talks only to its own origin: no CORS
// and no second port for the browser to know, and the service refuses requests that come from a page.
export const VOICE_TRANSCRIBE_PATH = "/mango/voice/transcribe"

// Live dictation: the page sends PCM chunks while the user speaks and receives the events
// (`partial`, `final`, `error`) the service produces with its VAD.
export const VOICE_LIVE_START_PATH = "/mango/voice/live/start"
export const VOICE_LIVE_PCM_PATH = "/mango/voice/live/pcm"
export const VOICE_LIVE_END_PATH = "/mango/voice/live/end"

// The first clip after startup waits for the service to finish loading the model.
const UPSTREAM_TIMEOUT_MS = 11 * 60_000
const CHUNK_TIMEOUT_MS = 60_000

const DICTATION_OFF = () =>
  tr(
    "dettatura spenta: il servizio di trascrizione non e' acceso (si accende con mango-code -Web)",
    "dictation is off: the transcription service is not running (it starts with mango-code -Web)",
  )

function error(status: number, message: string) {
  return HttpServerResponse.jsonUnsafe({ error: message }, { status })
}

// Forwarding of live dictation: same port and same origin as the page, so the browser does not need to know
// the service or send Origin (which the service refuses).
export function voiceLiveEffect(kind: "start" | "pcm" | "end", request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const base = process.env.MANGO_VOICE_URL
    if (!base)
      return error(503, DICTATION_OFF())

    const search = new URL(request.url, "http://localhost").search

    let body: ArrayBuffer | undefined
    if (kind === "pcm") {
      const audio = yield* request.arrayBuffer.pipe(Effect.option)
      if (audio._tag === "None") return error(400, tr("audio illeggibile nella richiesta", "the audio in the request cannot be read"))
      if (audio.value.byteLength === 0) return error(400, tr("audio vuoto", "empty audio"))
      body = audio.value
    }

    const upstream = yield* Effect.tryPromise(() =>
      fetch(new URL(`/live/${kind}${search}`, base), {
        method: "POST",
        body,
        headers: body ? { "content-type": "application/octet-stream" } : undefined,
        signal: AbortSignal.timeout(kind === "pcm" ? CHUNK_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
      }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => undefined) })),
    ).pipe(Effect.option)

    if (upstream._tag === "None")
      return error(
        502,
        tr(`il servizio di trascrizione non risponde (${base})`, `the transcription service is not answering (${base})`),
      )
    if (!upstream.value.json || typeof upstream.value.json !== "object")
      return error(
        502,
        tr("risposta non valida dal servizio di trascrizione", "invalid response from the transcription service"),
      )
    return HttpServerResponse.jsonUnsafe(upstream.value.json, { status: upstream.value.status })
  })
}

export function voiceTranscribeEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const base = process.env.MANGO_VOICE_URL
    if (!base)
      return error(503, DICTATION_OFF())

    const body = yield* request.arrayBuffer.pipe(Effect.option)
    if (body._tag === "None") return error(400, tr("audio illeggibile nella richiesta", "the audio in the request cannot be read"))
    if (body.value.byteLength === 0) return error(400, tr("audio vuoto", "empty audio"))

    const upstream = yield* Effect.tryPromise(() =>
      fetch(new URL("/transcribe", base), {
        method: "POST",
        body: body.value,
        headers: { "content-type": request.headers["content-type"] ?? "application/octet-stream" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => undefined) })),
    ).pipe(Effect.option)
    if (upstream._tag === "None")
      return error(
        502,
        tr(`il servizio di trascrizione non risponde (${base})`, `the transcription service is not answering (${base})`),
      )
    if (!upstream.value.json || typeof upstream.value.json !== "object")
      return error(
        502,
        tr("risposta non valida dal servizio di trascrizione", "invalid response from the transcription service"),
      )
    return HttpServerResponse.jsonUnsafe(upstream.value.json, { status: upstream.value.status })
  })
}
