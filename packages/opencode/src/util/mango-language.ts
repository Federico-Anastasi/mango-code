// mango-code: the language of the texts the user reads (errors shown on the settings page, HTTP error messages).
// The choice lives in `"language": "it" | "en"` of the settings file (`MANGO_SETTINGS`, the same file as the prompt
// settings). Without a valid choice the agent follows the Windows display language (`MANGO_SYSTEM_LANGUAGE`, set by
// the app and the terminal; else the regional format): Italian when it is Italian, English otherwise. The file is read at every call, so a change applies to the next message.

import fs from "node:fs"
import path from "node:path"

export type Language = "it" | "en"

const isLanguage = (value: unknown): value is Language => value === "it" || value === "en"

/** The language chosen in the settings file, if there is a valid one. */
export function chosenLanguage(): Language | undefined {
  const file = process.env.MANGO_SETTINGS
  if (!file) return
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { language?: unknown } | null
    return isLanguage(json?.language) ? json.language : undefined
  } catch {
    return
  }
}

/** The current language: the chosen one, else the system's. */
export function language(): Language {
  if (chosenLanguage()) return chosenLanguage()!
  if (isLanguage(process.env.MANGO_SYSTEM_LANGUAGE)) return process.env.MANGO_SYSTEM_LANGUAGE
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("it") ? "it" : "en"
}

/** A user-facing text in both languages: the one of the current language. */
export const tr = (it: string, en: string) => (language() === "it" ? it : en)

/**
 * Saves the choice in the settings file, keeping its other keys; `null` removes it (follow the system).
 * Throws if there is no settings file to write or the existing one is not a JSON object.
 */
export function setChosenLanguage(value: Language | null) {
  const file = process.env.MANGO_SETTINGS
  if (!file)
    throw new Error(
      tr(
        "manca MANGO_SETTINGS: l'agente non e' stato avviato da Mango Code",
        "MANGO_SETTINGS is missing: the agent was not started by Mango Code",
      ),
    )
  const json = readObject(file)
  if (value === null) delete json.language
  else json.language = value
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(json, null, 2) + "\n")
  fs.renameSync(temporary, file)
}

function readObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {}
  const json: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new Error(tr(`${file}: deve essere un oggetto JSON`, `${file}: must be a JSON object`))
  return json as Record<string, unknown>
}
