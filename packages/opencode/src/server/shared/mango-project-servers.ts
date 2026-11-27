import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import fs from "node:fs"
import path from "node:path"
import type { InstanceStore } from "@/project/instance-store"
import { PromptSettings } from "@/session/settings"
import { tr } from "@/util/mango-language"

// mango-code: the MCP servers of a project's `.mcp.json` start programs, so they start only once the user allowed
// them (the mango-project plugin, which keeps what it found in the registry under PROJECT_SERVERS_KEY). The approval
// is for that file as it is now: a change to it asks again. It lives in Mango Code's own settings file (`mcpApproved`),
// never in the project, which could allow itself.
//   GET  /mango/project-servers?directory=<work>  ->  {file, servers: [{name, run}], approved}  (file null: none)
//   POST /mango/project-servers?directory=<work>  ->  the same, approved; the servers start at once, or when no
//   conversation is answering any more (starting them restarts the folder, which would cut an answer)
// The POST is meant for the window (it carries `Origin`; a request without one gets 403), as the settings are.
export const PROJECT_SERVERS_PATH = "/mango/project-servers"
export const PROJECT_SERVERS_KEY = Symbol.for("mango.projectServers")

type Found = { file: string; hash: string; approved: boolean; servers: { name: string; run: string }[] }
const registry = () => ((globalThis as Record<symbol, unknown>)[PROJECT_SERVERS_KEY] ??= new Map()) as Map<string, Found>
const found = (directory: string) => registry().get(path.resolve(directory).toLowerCase())

const failure = (message: string, status = 400) => HttpServerResponse.jsonUnsafe({ error: message }, { status })
const shown = (f: Found | undefined) =>
  HttpServerResponse.jsonUnsafe(f ? { file: f.file, servers: f.servers, approved: f.approved } : { file: null, servers: [], approved: true })

function approve(f: Found) {
  const file = PromptSettings.defaultFile()
  if (!file)
    throw new Error(
      tr(
        "manca MANGO_SETTINGS: l'agente non è stato avviato da Mango Code",
        "MANGO_SETTINGS is missing: the agent was not started by Mango Code",
      ),
    )
  const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {}
  json.mcpApproved = { ...json.mcpApproved, [f.file.toLowerCase()]: f.hash }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(json, null, 2) + "\n")
  fs.renameSync(`${file}.tmp`, file)
}

export function projectServersEffect(
  request: HttpServerRequest.HttpServerRequest,
  store: InstanceStore.Interface,
  afterTheAnswers: (work: Effect.Effect<void>) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
    if (!directory) return failure(tr("manca directory", "directory is missing"))
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
      return failure(tr(`non è una cartella: ${directory}`, `not a folder: ${directory}`), 404)
    // The plugin reads the folder when its instance starts.
    yield* store.provide({ directory }, Effect.void)
    if (request.method === "GET") return shown(found(directory))

    if (!request.headers["origin"])
      return failure(
        tr("i server del progetto si consentono dalla finestra di Mango Code", "a project's servers are allowed from the Mango Code window"),
        403,
      )
    const before = found(directory)
    if (!before || before.approved) return shown(before)
    try {
      approve(before)
    } catch (e) {
      return failure(e instanceof Error ? e.message : String(e), 500)
    }
    // The instance starts again, when no conversation is answering (it would cut the answer): the plugin reads the
    // approval and the servers start.
    yield* afterTheAnswers(store.disposeDirectory(directory).pipe(Effect.andThen(store.provide({ directory }, Effect.void))))
    return shown({ ...before, approved: true })
  })
}
