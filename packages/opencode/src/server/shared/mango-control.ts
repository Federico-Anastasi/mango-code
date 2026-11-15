import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { tr } from "@/util/mango-language"

// mango-code: what the interface reads about the model, the models and the computer, the two things a phone may ask
// too, and the pictures. The app's control server answers them: it lives on the engine manager's port, always on
// this PC, also when the engine is another PC's, and the app gives its address in MANGO_CONTROL_URL. The agent only
// forwards, so the window, the phone and a browser talk to their own origin, and the control server keeps refusing the
// requests of web pages. Status, type and body are the control server's.
// A control server that does not answer in time, or an agent the app did not start, gives 503.
// Each route goes to the same path under `/control`.
export const CONTROL_ROUTES = [
  { method: "GET", path: "/mango/state" },
  { method: "GET", path: "/mango/models" },
  { method: "GET", path: "/mango/computer" },
  { method: "POST", path: "/mango/model/use" },
  { method: "POST", path: "/mango/model/retry" },
  // A picture is a job: asked, followed step by step with its number, fetched when done, or cancelled.
  { method: "GET", path: "/mango/image" },
  { method: "POST", path: "/mango/image/generate" },
  { method: "POST", path: "/mango/image/unload" },
  { method: "GET", path: "/mango/image/jobs/:id" },
  { method: "GET", path: "/mango/image/jobs/:id/picture" },
  { method: "POST", path: "/mango/image/jobs/:id/cancel" },
] as const

// The models and the computer are read with the hardware, a matter of a second or two; the state answers at once,
// and so does a picture that is asked: it is made after the answer.
const TIMEOUT_MS = 10_000
// `{model, once}` is a few dozen bytes and the request for a picture a few thousand: a larger body is not one of these.
const MAX_BODY = 16 * 1024
// The number of a job is the only part of a path the caller chooses: with letters, digits and dashes alone the
// target cannot leave the route's own path.
const PATH = /^[A-Za-z0-9/-]+$/

export function controlEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const base = process.env.MANGO_CONTROL_URL
    if (!base) return unavailable()
    const pathname = new URL(request.url, "http://localhost").pathname
    if (!PATH.test(pathname))
      return HttpServerResponse.jsonUnsafe(
        { error: { message: tr("rotta sconosciuta", "unknown route"), type: "mango_control" } },
        { status: 404 },
      )
    const target = pathname.replace("/mango/", "/control/")
    const body = request.method === "POST" ? yield* request.arrayBuffer.pipe(Effect.option) : undefined
    if (body?._tag === "None")
      return HttpServerResponse.jsonUnsafe(
        { error: { message: tr("richiesta illeggibile", "the request cannot be read"), type: "mango_control" } },
        { status: 400 },
      )
    if (body && body.value.byteLength > MAX_BODY)
      return HttpServerResponse.jsonUnsafe(
        { error: { message: tr("richiesta troppo grande", "the request is too large"), type: "mango_control" } },
        { status: 413 },
      )
    const sent = body?.value.byteLength ? body.value : undefined
    const upstream = yield* Effect.tryPromise(() =>
      fetch(new URL(target, base), {
        method: request.method,
        body: sent,
        headers: sent ? { "content-type": "application/json" } : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).then(async (response) => ({
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        text: await response.text(),
      })),
    ).pipe(Effect.option)
    if (upstream._tag === "None") return unavailable()
    return HttpServerResponse.text(upstream.value.text, {
      status: upstream.value.status,
      contentType: upstream.value.contentType,
    })
  })
}

// The shape of the control server's own errors, so the interface reads one.
function unavailable() {
  return HttpServerResponse.jsonUnsafe(
    {
      error: {
        message: tr("l'app Mango Code non risponde", "the Mango Code app is not answering"),
        type: "mango_control",
      },
    },
    { status: 503 },
  )
}
