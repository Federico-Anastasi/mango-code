import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Harness } from "@/session/harness"
import { PromptSettings } from "@/session/settings"
import { tr } from "@/util/mango-language"

// mango-code: the harnesses of the settings page (see session/harness.ts).
//   GET    /mango/harness              -> { default, harnesses: [{ id, name, fixed, kind, from?, error? }] }
//   GET    /mango/harness?id=<name>    -> { id, name, fixed, kind, from?, prompt, tools: {name: description},
//                                           hooks: {name: {on, every?, times?}}, texts: {name: text},
//                                           compaction: {name: text} }
//          `prompt`: the base prompt the model reads; `tools`: the descriptions this harness changes or brings (those of
//          the agent's own tools are in the items of /mango/settings); `hooks`: every hook its kind runs, as the
//          harness has it (the switches of the page are in /mango/settings); `compaction`: the texts of the summary
//          (`COMPACTION_TEXTS` in session/harness.ts), all of them.
//   POST   /mango/harness              {"from", "name"} -> { id }: a copy of a harness, the user's own.
//   PUT    /mango/harness?id=<name>    {"name"?, "prompt"?, "tools"?, "hooks"?, "texts"?, "compaction"?} -> the harness as
//                                      GET gives it
//   DELETE /mango/harness?id=<name>    -> {}: only a harness of the user's that no model uses; its switches leave the file
//                                           for all folders.
// The changes go only through the page (they carry `Origin`), as those of /mango/settings.
export const HARNESS_PATH = "/mango/harness"

const failure = (message: string, status = 400) => HttpServerResponse.jsonUnsafe({ error: message }, { status })
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function shown(id: string) {
  const h = Harness.definition(id)
  const listed = Harness.list().find((item) => item.id === id)
  const hooks = Object.fromEntries(
    Object.entries(Harness.HOOKS)
      .filter(([, known]) => known.kinds.includes(h.kind))
      .map(([name, known]) => [name, h.hooks[name] ? { ...known.numbers, ...h.hooks[name] } : { ...known.numbers, on: false }]),
  )
  return {
    id,
    name: h.name,
    fixed: h.fixed,
    kind: h.kind,
    ...(listed?.from ? { from: listed.from } : {}),
    prompt: Harness.promptText(h),
    tools: Object.fromEntries(Object.entries(h.tools ?? {}).map(([name, tool]) => [name, tool.description])),
    hooks,
    texts: Object.fromEntries(Object.keys(hooks).map((name) => [name, h.texts[name] ?? ""])),
    compaction: Object.fromEntries(Harness.COMPACTION_TEXTS.map((name) => [name, h.compaction[name]])),
  }
}

/** The body of a change, checked in its shape; what it says is checked by the harness before anything is written. */
function change(body: unknown): Harness.Change | string {
  if (!isObject(body)) return tr("il corpo deve essere un oggetto JSON", "the body must be a JSON object")
  const texts = (v: unknown) => isObject(v) && Object.values(v).every((x) => typeof x === "string")
  if (body.name !== undefined && typeof body.name !== "string") return tr("«name» deve essere un testo", `"name" must be a text`)
  if (body.prompt !== undefined && typeof body.prompt !== "string") return tr("«prompt» deve essere un testo", `"prompt" must be a text`)
  if (body.tools !== undefined && !texts(body.tools)) return tr("«tools» deve dare un testo per strumento", `"tools" must give a text for each tool`)
  if (body.texts !== undefined && !texts(body.texts)) return tr("«texts» deve dare un testo per gancio", `"texts" must give a text for each hook`)
  if (body.compaction !== undefined && !texts(body.compaction))
    return tr("«compaction» deve dare un testo per voce del riassunto", `"compaction" must give a text for each text of the summary`)
  if (body.hooks !== undefined && !(isObject(body.hooks) && Object.values(body.hooks).every(isObject)))
    return tr("«hooks» deve dare un oggetto per gancio", `"hooks" must give an object for each hook`)
  return body as Harness.Change
}

export function harnessEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    const id = new URL(request.url, "http://localhost").searchParams.get("id")
    if (request.method === "GET") {
      if (!id) return HttpServerResponse.jsonUnsafe({ default: Harness.DEFAULT, harnesses: Harness.list() })
      try {
        return HttpServerResponse.jsonUnsafe(shown(id))
      } catch (e) {
        return failure(reason(e), 404)
      }
    }
    if (!request.headers["origin"])
      return failure(
        tr("gli harness si cambiano dalla pagina delle impostazioni di Mango Code", "harnesses are changed from the Mango Code settings page"),
        403,
      )
    const read = yield* request.json.pipe(Effect.option)
    const body = read._tag === "Some" ? read.value : undefined
    if (request.method === "POST") {
      if (!isObject(body) || typeof body.from !== "string" || typeof body.name !== "string")
        return failure(tr("servono «from» e «name»", `"from" and "name" are needed`))
      const { from, name } = body
      const made = yield* Effect.promise(() => Harness.duplicate(from, name).then((id) => ({ id }), (e: unknown) => ({ error: reason(e) })))
      return "error" in made ? failure(made.error) : HttpServerResponse.jsonUnsafe(made)
    }
    if (!id) return failure(tr("manca id", "id is missing"))
    if (request.method === "DELETE") {
      // its switches go with it: a harness made later with its name starts clean
      const gone = yield* Effect.promise(() =>
        Harness.remove(id).then(
          () => {
            PromptSettings.forget(id)
            return {}
          },
          (e: unknown) => ({ error: reason(e) }),
        ),
      )
      return "error" in gone ? failure(gone.error) : HttpServerResponse.jsonUnsafe({})
    }
    const changed = change(body)
    if (typeof changed === "string") return failure(changed)
    const done = yield* Effect.promise(() => Harness.update(id, changed).then(() => ({}), (e: unknown) => ({ error: reason(e) })))
    return "error" in done ? failure(done.error) : HttpServerResponse.jsonUnsafe(shown(id))
  })
}
