import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerAuth } from "@/server/auth"
import { tr } from "@/util/mango-language"

// mango-code: the server runs without a password on 127.0.0.1 and the agent has the shell. CORS is not enough:
// a "simple" request (POST text/plain) leaves from any page without a preflight, and the server runs it even if
// the browser then cannot read the response. So a request with Origin passes only if it comes from the web UI of
// this same server or from the app; without Origin (the app, clients on the PC, curl) it passes.
// Pages of other local ports are also left out, such as the dev server of a project opened in the preview panel.
// A page whose name is made to resolve to 127.0.0.1 (DNS rebinding) has Host and Origin equal, and its reads carry no
// Origin: so, without a password, the Host must also name the loopback. The phone service forwards with its own
// `127.0.0.1:<port>` Host and Origin, so it passes as local.
export function isTrustedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true
  try {
    return Boolean(host) && new URL(origin).host === host
  } catch {
    return false
  }
}

// A page of another site can send the browser to an API address: a GET navigation carries no Origin, so the check
// above lets it through, and the answer would be shown as a page of this server's origin. Browsers label such a
// request: Sec-Fetch-Site names the site that started it and Sec-Fetch-Mode says it is a navigation. Clients that send
// neither (the app's own calls, curl, the terminal), pages of this server and typed addresses ("none") are not touched.
export function isForeignApiNavigation(headers: Record<string, string | undefined>, url: string): boolean {
  const site = headers["sec-fetch-site"]
  if (site !== "cross-site" && site !== "same-site") return false
  if (headers["sec-fetch-mode"] !== "navigate") return false
  const pathname = new URL(url, "http://localhost").pathname
  return pathname === "/api" || pathname.startsWith("/api/")
}

// A POST to the agent's own routes (`/mango/*`) must say it carries JSON, or the dictation's audio. Sent by a page of
// another site, such a request needs a preflight, which CORS refuses; a "simple" one (text/plain, a form, no type)
// would leave without asking.
const AGENT_POST_TYPES = new Set(["application/json", "application/octet-stream"])

export function isSimpleAgentPost(method: string, url: string, contentType: string | undefined): boolean {
  if (method !== "POST") return false
  if (!new URL(url, "http://localhost").pathname.startsWith("/mango/")) return false
  return !AGENT_POST_TYPES.has((contentType ?? "").split(";")[0].trim().toLowerCase())
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

export function isLocalHost(host: string): boolean {
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

export const originGuard = HttpRouter.middleware(
  Effect.gen(function* () {
    const keyed = ServerAuth.required(yield* ServerAuth.Config)
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const host = request.headers["host"]
        // No Host: a call inside the process (the terminal), not a browser.
        const localHost = keyed || host === undefined || isLocalHost(host)
        if (
          !localHost ||
          !isTrustedOrigin(request.headers["origin"], host) ||
          isForeignApiNavigation(request.headers, request.url)
        ) {
          return HttpServerResponse.jsonUnsafe(
            { error: tr("richiesta da una pagina web non ammessa", "request from a web page not allowed") },
            { status: 403 },
          )
        }
        if (isSimpleAgentPost(request.method, request.url, request.headers["content-type"]))
          return HttpServerResponse.jsonUnsafe(
            { error: tr("la richiesta deve essere in JSON", "the request must be JSON") },
            { status: 415 },
          )
        return yield* effect
      })
  }),
  { global: true },
)
