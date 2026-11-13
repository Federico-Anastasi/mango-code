import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync, statSync } from "node:fs"
import type { InstanceStore } from "@/project/instance-store"
import type { SessionPrompt } from "@/session/prompt"
import { PromptSettings } from "@/session/settings"
import { PromptMeasurement } from "@/session/prompt-measurement"
import { tr } from "@/util/mango-language"

// mango-code: the prompt settings page (see session/settings.ts) reads and changes what goes into the prompt of the
// folder `?directory=`.
//   GET /mango/settings?directory=<work>
//     -> { directory, model, file: {default, folder}, items: [{type, name, tokens, enabled, source}] }
//        `type`: tools, mcp, skills, instructions, plugins (can be turned on and off) and base (the base prompt, fixed).
//        `tokens`: the weight measured with the first request of a conversation, `null` if there is none (the page says
//        "not measured"). `source`: `default` or `folder`, which file the on/off comes from.
//        An agent without any model has no request to list: `model` null and no items.
//   PUT /mango/settings?directory=<work>  {"type", "name", "enabled", "scope": "all" | "folder"}
//     -> the changed item. It applies from the next message.
// The PUT is meant to go only through the page (it carries `Origin`; a request without one gets 403): connected apps
// add to the prompt and do not turn anything off. A rule between apps, not a barrier: a process on the PC can send an
// `Origin` of its own.
export const SETTINGS_PATH = "/mango/settings"

const failure = (message: string, status = 400) => HttpServerResponse.jsonUnsafe({ error: message }, { status })
const isKind = (v: unknown): v is PromptSettings.Kind => (PromptSettings.KINDS as readonly string[]).includes(v as string)

function loadValid(directory: string): { valid: PromptSettings.Valid } | { error: string } {
  try {
    return { valid: PromptSettings.load(directory) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export function settingsEffect(
  request: HttpServerRequest.HttpServerRequest,
  store: InstanceStore.Interface,
  prompt: SessionPrompt.Interface,
) {
  return Effect.gen(function* () {
    const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
    if (!directory) return failure(tr("manca directory", "directory is missing"))
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      return failure(tr(`non e' una cartella: ${directory}`, `not a folder: ${directory}`), 404)
    const loaded = loadValid(directory)
    if ("error" in loaded) return failure(loaded.error, 500)

    if (request.method === "GET") {
      // The weights of the model that ran the folder's latest conversation: chosen in the chat, it can differ from
      // the agent's default model, and its measurements are the ones there are. The items are those of its request.
      const listed = yield* store.provide({ directory }, prompt.items(PromptMeasurement.measuredModel(directory)))
      const problem = PromptMeasurement.takeProblem()
      if (problem) yield* Effect.logWarning("prompt: weights not read", { reason: problem })
      const model = PromptMeasurement.measuredModel(directory) ?? listed.model
      const items = listed.items
      const { valid } = loaded
      return HttpServerResponse.jsonUnsafe({
        directory,
        model,
        file: { default: PromptSettings.defaultFile() ?? null, folder: PromptSettings.folderFile(directory) },
        items: items.map((item) => {
          const tokens = (model && PromptMeasurement.tokens(directory, model, item)) ?? null
          if (!isKind(item.kind)) return { type: item.kind, name: item.name, tokens, enabled: true, source: null }
          return {
            type: item.kind,
            name: item.name,
            tokens,
            enabled: PromptSettings.enabled(valid, item.kind, item.name),
            source: PromptSettings.source(valid, item.kind, item.name),
          }
        }),
      })
    }

    if (!request.headers["origin"])
      return failure(
        tr(
          "le impostazioni si cambiano dalla pagina delle impostazioni di Mango Code",
          "settings are changed from the Mango Code settings page",
        ),
        403,
      )
    const body = yield* request.json.pipe(Effect.option)
    const c = (body._tag === "Some" ? body.value : undefined) as
      | { type?: unknown; name?: unknown; enabled?: unknown; scope?: unknown }
      | undefined
    if (!c || !isKind(c.type))
      return failure(
        tr(
          `«type» deve essere uno fra: ${PromptSettings.KINDS.join(", ")}`,
          `"type" must be one of: ${PromptSettings.KINDS.join(", ")}`,
        ),
      )
    if (typeof c.name !== "string" || !c.name)
      return failure(tr("«name» deve essere il nome di una voce", `"name" must be the name of an item`))
    if (typeof c.enabled !== "boolean") return failure(tr("«enabled» deve essere true o false", `"enabled" must be true or false`))
    if (c.scope !== "all" && c.scope !== "folder")
      return failure(tr("«scope» deve essere «all» o «folder»", `"scope" must be "all" or "folder"`))
    try {
      PromptSettings.write(directory, c.scope, c.type, c.name, c.enabled)
    } catch (e) {
      return failure(e instanceof Error ? e.message : String(e), 500)
    }
    const after = loadValid(directory)
    if ("error" in after) return failure(after.error, 500)
    return HttpServerResponse.jsonUnsafe({
      type: c.type,
      name: c.name,
      enabled: PromptSettings.enabled(after.valid, c.type, c.name),
      source: PromptSettings.source(after.valid, c.type, c.name),
    })
  })
}
