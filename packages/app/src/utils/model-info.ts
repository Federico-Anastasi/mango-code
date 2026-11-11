import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { authTokenFromCredentials } from "@/utils/server"

// mango-code: what the model menu says about each model besides its name (see the agent's shared/mango-models.ts):
// weight, where it runs, how fast it writes on the processor, whether it reads images, and the warning of a model the catalog
// does not trust as an agent. The line and the warning are told in the language of the interface.

export type ModelInfo = {
  bytes?: number
  place?: "gpu" | "cpu" | "remote" | "none"
  speed?: "very_slow" | "slow" | "fair" | "quick"
  weak?: boolean
}

const PLACES = new Set(["gpu", "cpu", "remote", "none"])
const SPEEDS = new Set(["very_slow", "slow", "fair", "quick"])

/** The agent's answer, by model key: what it does not say right is left out, so the menu shows less and never breaks. */
export function parseModelsInfo(body: unknown): Record<string, ModelInfo> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {}
  const result: Record<string, ModelInfo> = {}
  for (const [key, raw] of Object.entries(body)) {
    if (!raw || typeof raw !== "object") continue
    const value = raw as Record<string, unknown>
    result[key] = {
      ...(typeof value.bytes === "number" && value.bytes > 0 ? { bytes: value.bytes } : {}),
      ...(typeof value.place === "string" && PLACES.has(value.place) ? { place: value.place as ModelInfo["place"] } : {}),
      ...(typeof value.speed === "string" && SPEEDS.has(value.speed) ? { speed: value.speed as ModelInfo["speed"] } : {}),
      ...(value.weak === true ? { weak: true } : {}),
    }
  }
  return result
}

/** Asks the agent; a server without the route (a plain browser, the terminal) has nothing to say. */
export async function fetchModelsInfo(server: { url: string; http: { username?: string; password?: string } }) {
  const headers: Record<string, string> = {}
  if (server.http.password)
    headers.authorization = `Basic ${authTokenFromCredentials({ username: server.http.username, password: server.http.password })}`
  const response = await fetch(new URL("/mango/models/info", server.url), { headers, signal: AbortSignal.timeout(10_000) })
  return response.ok ? parseModelsInfo(await response.json().catch(() => undefined)) : {}
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The line under the name: "18 GB · On the graphics card · Reads images", and the warning if there is one. A model of another PC
 * has no "where": its name already says which PC.
 */
export function modelDetail(info: ModelInfo | undefined, model: { images: boolean }, t: Translate, locale?: string) {
  if (!info) return
  const where =
    info.place === "gpu"
      ? t("dialog.model.info.gpu")
      : info.place === "cpu"
        ? [t("dialog.model.info.cpu"), info.speed && t(`dialog.model.info.speed.${info.speed}`)].filter(Boolean).join(" · ")
        : info.place === "none"
          ? t("dialog.model.info.none")
          : undefined
  const line = [info.bytes ? formatFileSize(info.bytes, locale) : undefined, where, model.images ? t("dialog.model.info.images") : undefined]
    .filter(Boolean)
    .join(" · ")
  return { line, warning: info.weak ? t("dialog.model.info.weak") : undefined }
}
