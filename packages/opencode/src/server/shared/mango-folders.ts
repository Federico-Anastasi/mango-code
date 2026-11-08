import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { tr } from "@/util/mango-language"

// mango-code: extra folders for the context of a working folder (`?directory=`). An app that keeps its method
// (CLAUDE.md, rules, skills) in a folder other than the one the agent works in declares it here, once. The
// skills are read by the skill service (skill/index.ts, at every use: it applies at once, also to conversations
// already open); the instructions are read by the mango-project plugin, which lives in the same process and
// sees the same list in `globalThis`. The list stays in memory as long as the agent is running.
//   PUT /mango/extra-folders?directory=<work>  {"folders": ["C:\code", ...]}  ->  {folders, changed}
//   GET /mango/extra-folders?directory=<work>  ->  {folders}
export const FOLDERS_PATH = "/mango/extra-folders"
// The key is shared with the mango-project plugin, which reads the same list.
export const FOLDERS_KEY = Symbol.for("mango.folders")

type Registry = Map<string, string[]>
const registry = (): Registry => ((globalThis as Record<symbol, unknown>)[FOLDERS_KEY] ??= new Map()) as Registry
const keyOf = (directory: string) => path.resolve(directory).toLowerCase()

/** The extra folders declared for the working folder `directory`. */
export const foldersOf = (directory: string): string[] => registry().get(keyOf(directory)) ?? []

const failure = (message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 })

export function foldersEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
    if (!directory) return failure(tr("manca directory", "directory is missing"))
    const current = foldersOf(directory)
    if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ folders: current })

    const body = yield* request.json.pipe(Effect.option)
    const folders = body._tag === "Some" ? (body.value as { folders?: unknown })?.folders : undefined
    if (!Array.isArray(folders) || !folders.every((c) => typeof c === "string"))
      return failure(tr("«folders» deve essere un elenco di percorsi", "\"folders\" must be a list of paths"))
    const next = [...new Set(folders.map((c) => path.resolve(c)))]
    const missing = next.find((c) => !existsSync(c) || !statSync(c).isDirectory())
    if (missing) return failure(tr(`non e' una cartella: ${missing}`, `not a folder: ${missing}`))

    const changed = next.join("|") !== current.join("|")
    if (changed) registry().set(keyOf(directory), next)
    return HttpServerResponse.jsonUnsafe({ folders: next, changed })
  })
}
