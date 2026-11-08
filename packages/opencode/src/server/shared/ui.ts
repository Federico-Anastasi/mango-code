import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  // The browser's HTML parser turns CRLF (and lone CR) line breaks into LF before computing the hash of the
  // inline script: if the theme file was read with CRLF (a checkout on Windows) the hash computed here on the
  // raw text does not match and the browser blocks the script.
  return csp(match ? createHash("sha256").update(match[2].replace(/\r\n?/g, "\n")).digest("base64") : "")
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
) {
  const file = embeddedWebUI[requestPath.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

// mango-code: the web UI is ONLY the one embedded in the binary. Upstream, if the build does not contain it,
// forwards it from app.opencode.ai: not here, because the app must not depend on other people's servers.
// Without an embedded UI the answer is 404 and the reason is in the body.
export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: { fs: FSUtil.Interface; disableEmbeddedWebUi: boolean },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname
    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI)
    return HttpServerResponse.jsonUnsafe(
      { error: "Web UI not embedded in this build (built with --skip-embed-web-ui)" },
      { status: 404 },
    )
  })
}

// The static files of the web UI (js, css, fonts, images) contain no data: they are served without a
// password, so the address with ?auth_token= opens the page without the browser's popup for every asset.
// index.html and the SPA fallback stay protected, like the APIs.
export function isEmbeddedUIAsset(method: string, pathname: string) {
  if (method !== "GET" && method !== "HEAD") return Effect.succeed(false)
  const file = pathname.replace(/^\//, "")
  if (!file || file.endsWith(".html")) return Effect.succeed(false)
  return Effect.promise(() => embeddedUI(false)).pipe(Effect.map((ui) => !!ui && file in ui))
}
