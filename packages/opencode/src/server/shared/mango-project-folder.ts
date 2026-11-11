import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"
import { isBroadFolder } from "@/project/broad-folder"
import { tr } from "@/util/mango-language"

// mango-code: what the web UI asks before it makes a project of a folder (from the app, from the phone).
//   GET  /mango/folder?directory=<folder>  ->  {"broad": true | false}   (true: too broad to be a project, see project/broad-folder.ts)
//   POST /mango/folder  {"parent": "<folder>", "name": "<name>"}  ->  {"directory": "<parent>\<name>"}   (creates the subfolder)
export const FOLDER_PATH = "/mango/folder"

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** The reason a folder name is refused, in the language of the user; undefined if it is fine. */
export function folderNameProblem(raw: string) {
  const name = raw.trim()
  if (!name) return tr("il nome è vuoto", "the name is empty")
  if (name.length > 100) return tr("il nome supera i 100 caratteri", "the name is longer than 100 characters")
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name))
    return tr("il nome contiene caratteri non ammessi da Windows", "the name contains characters Windows does not allow")
  if (name.endsWith(".")) return tr("il nome non può finire con un punto", "the name cannot end with a dot")
  if (RESERVED.test(name.split(".")[0]!.trimEnd())) return tr("nome riservato da Windows", "name reserved by Windows")
}

/** Creates `<parent>\<name>`; the error says what to do. */
export function createSubfolder(parent: string, raw: string): { error: string } | { directory: string } {
  const problem = folderNameProblem(raw)
  if (problem) return { error: problem }
  if (!path.isAbsolute(parent) || !existsSync(parent) || !statSync(parent).isDirectory())
    return { error: tr(`la cartella «${parent}» non esiste`, `the folder «${parent}» does not exist`) }
  const directory = path.join(parent, raw.trim())
  if (existsSync(directory))
    return { error: tr("esiste già una cartella con questo nome: scegli un altro nome", "a folder with this name already exists: choose another name") }
  mkdirSync(directory)
  return { directory }
}

const failure = (message: string) => HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 })

export function projectFolderEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    if (request.method === "GET") {
      const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
      if (!directory) return failure(tr("manca directory", "directory is missing"))
      return HttpServerResponse.jsonUnsafe({ broad: isBroadFolder(directory) })
    }
    const body = yield* request.json.pipe(Effect.option)
    const input = body._tag === "Some" ? (body.value as { parent?: unknown; name?: unknown } | null) : undefined
    const parent = input?.parent
    const name = input?.name
    if (typeof parent !== "string" || typeof name !== "string")
      return failure(tr("servono «parent» e «name»", "\"parent\" and \"name\" are needed"))
    try {
      const created = createSubfolder(parent, name)
      return "error" in created ? failure(created.error) : HttpServerResponse.jsonUnsafe(created)
    } catch (e) {
      return HttpServerResponse.jsonUnsafe({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  })
}
