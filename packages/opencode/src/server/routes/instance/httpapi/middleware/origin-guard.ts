import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { tr } from "@/util/mango-language"

// mango-code: the server runs without a password on 127.0.0.1 and the agent has the shell. CORS is not enough:
// a "simple" request (POST text/plain) leaves from any page without a preflight, and the server runs it even if
// the browser then cannot read the response. So a request with Origin passes only if it comes from the web UI of
// this same server or from the app; without Origin (the app, clients on the PC, curl) it passes.
// Pages of other local ports are also left out, such as the dev server of a project opened in the preview panel.
export function isTrustedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    return false
  }
}

export const originGuard = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!isTrustedOrigin(request.headers["origin"], request.headers["host"])) {
        return HttpServerResponse.jsonUnsafe(
          { error: tr("richiesta da una pagina web non ammessa", "request from a web page not allowed") },
          { status: 403 },
        )
      }
      return yield* effect
    }),
  { global: true },
)
