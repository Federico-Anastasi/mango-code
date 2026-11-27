import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync, statSync } from "node:fs"
import type { InstanceStore } from "@/project/instance-store"
import type { SessionPrompt } from "@/session/prompt"
import { PromptSettings } from "@/session/settings"
import { Harness } from "@/session/harness"
import { PromptMeasurement } from "@/session/prompt-measurement"
import { tr } from "@/util/mango-language"

// mango-code: the prompt settings page (see session/settings.ts) reads and changes what goes into the prompt of the
// folder `?directory=`, for the harness `?harness=` (the default one if not given; see session/harness.ts).
//   GET /mango/settings?directory=<work>&harness=<name>
//     -> { directory, harness, model, file: {default, folder}, items: [{type, name, tokens, enabled, source}] }
//        `type`: tools, mcp, skills, instructions, plugins, hooks (can be turned on and off) and base (the base prompt,
//        fixed). A hook weighs nothing in the prompt (`tokens` null): it adds its text while the model works.
//        `tokens`: the weight measured with the first request of a conversation, `null` if there is none (the page says
//        "not measured"). `source`: `default` or `folder`, which file the on/off comes from.
//        An agent without any model has no request to list: `model` null and no items.
//   PUT /mango/settings?directory=<work>&harness=<name>  {"type", "name", "enabled", "scope": "all" | "folder"}
//     -> the changed item. It applies from the next message.
// The PUT is meant to go only through the page (it carries `Origin`; a request without one gets 403): connected apps
// add to the prompt and do not turn anything off. A rule between apps, not a barrier: a process on the PC can send an
// `Origin` of its own.
export const SETTINGS_PATH = "/mango/settings"

const failure = (message: string, status = 400) => HttpServerResponse.jsonUnsafe({ error: message }, { status })
const isKind = (v: unknown): v is PromptSettings.Kind => (PromptSettings.KINDS as readonly string[]).includes(v as string)

function loadValid(directory: string, harness: string): { valid: PromptSettings.Valid } | { error: string } {
  try {
    return { valid: PromptSettings.load(directory, harness) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** The description of a tool, from the text of its item (its declaration as JSON). */
const describedBy = (text: string | undefined) =>
  text ? ((JSON.parse(text) as { description?: string }).description ?? "") : ""

/** Whether an item is on: a hook as its harness has it unless the files say otherwise, any other item on unless they do. */
const on = (valid: PromptSettings.Valid, definition: Harness.Definition, kind: PromptSettings.Kind, name: string) =>
  kind === "hooks"
    ? (Harness.withSwitches(definition, (hook) => PromptSettings.chosen(valid, "hooks", hook)).hooks[name]?.on ?? false)
    : PromptSettings.enabled(valid, kind, name)

export function settingsEffect(
  request: HttpServerRequest.HttpServerRequest,
  store: InstanceStore.Interface,
  prompt: SessionPrompt.Interface,
) {
  return Effect.gen(function* () {
    const query = new URL(request.url, "http://localhost").searchParams
    const directory = query.get("directory")
    if (!directory) return failure(tr("manca directory", "directory is missing"))
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      return failure(tr(`non è una cartella: ${directory}`, `not a folder: ${directory}`), 404)
    const harness = query.get("harness") ?? Harness.DEFAULT
    let definition: Harness.Definition
    try {
      definition = Harness.definition(harness)
    } catch (e) {
      return failure(e instanceof Error ? e.message : String(e), 404)
    }
    const loaded = loadValid(directory, harness)
    if ("error" in loaded) return failure(loaded.error, 500)

    if (request.method === "GET") {
      // The weights of the model that ran the folder's latest conversation: chosen in the chat, it can differ from
      // the agent's default model, and its measurements are the ones there are. The items are those of its request.
      const listed = yield* store.provide(
        { directory },
        prompt.items(PromptMeasurement.measuredModel(directory, harness), harness),
      )
      const problem = PromptMeasurement.takeProblem()
      if (problem) yield* Effect.logWarning("prompt: weights not read", { reason: problem })
      const model = PromptMeasurement.measuredModel(directory, harness) ?? listed.model
      const { valid } = loaded
      // the hooks this harness can run, each on or off
      const hooks = (listed.model === null ? [] : Object.entries(Harness.HOOKS))
        .filter(([, known]) => known.kinds.includes(definition.kind))
        .map(([name]) => ({ kind: "hooks", name }))
      return HttpServerResponse.jsonUnsafe({
        directory,
        harness,
        model,
        file: { default: PromptSettings.defaultFile() ?? null, folder: PromptSettings.folderFile(directory) },
        items: [...listed.items, ...hooks].map((item) => {
          // a hook has no weight of its own: it adds its text only when it comes
          const tokens = item.kind === "hooks" || !model ? null : (PromptMeasurement.tokens(directory, model, item, harness) ?? null)
          if (!isKind(item.kind)) return { type: item.kind, name: item.name, tokens, enabled: true, source: null }
          return {
            type: item.kind,
            name: item.name,
            tokens,
            enabled: on(valid, definition, item.kind, item.name),
            // the words a tool is known by, for a harness of the user's to change them
            ...(item.kind === "tools" ? { description: describedBy((item as { text?: string }).text) } : {}),
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
      PromptSettings.write(directory, c.scope, c.type, c.name, c.enabled, harness)
    } catch (e) {
      return failure(e instanceof Error ? e.message : String(e), 500)
    }
    const after = loadValid(directory, harness)
    if ("error" in after) return failure(after.error, 500)
    return HttpServerResponse.jsonUnsafe({
      type: c.type,
      name: c.name,
      enabled: on(after.valid, definition, c.type, c.name),
      source: PromptSettings.source(after.valid, c.type, c.name),
    })
  })
}
