import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { chosenLanguage, setChosenLanguage, tr } from "@/util/mango-language"

// mango-code: the language of the web UI and of the agent's messages, shared with the app and the terminal.
//   GET /mango/language  ->  {"language": "it" | "en" | null}   (null: follow the system language)
//   PUT /mango/language  {"language": "it" | "en" | null}  ->  {"language"}
// It is the `language` key of the settings file (`MANGO_SETTINGS`); the other keys stay as they are.
export const LANGUAGE_PATH = "/mango/language"

export function languageEffect(request: HttpServerRequest.HttpServerRequest) {
  return Effect.gen(function* () {
    if (request.method === "GET") return HttpServerResponse.jsonUnsafe({ language: chosenLanguage() ?? null })

    const body = yield* request.json.pipe(Effect.option)
    const language = body._tag === "Some" ? (body.value as { language?: unknown } | null)?.language : undefined
    if (language !== "it" && language !== "en" && language !== null)
      return HttpServerResponse.jsonUnsafe(
        { error: tr("«language» deve essere «it», «en» o null", "\"language\" must be \"it\", \"en\" or null") },
        { status: 400 },
      )
    try {
      setChosenLanguage(language)
    } catch (e) {
      return HttpServerResponse.jsonUnsafe({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
    return HttpServerResponse.jsonUnsafe({ language: chosenLanguage() ?? null })
  })
}
