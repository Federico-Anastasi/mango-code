import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

// mango-code: what the model menu says about each model besides its name and what the config holds (context, images):
// its weight, where it runs (gpu, cpu, remote, none), how fast it writes on the processor, and the warning of a model the catalog
// does not trust as an agent. The app puts it in MANGO_MODELS_INFO (a JSON object by model key, see app/crates/agent-cfg).
//   GET /mango/models/info  ->  { "<key>": { bytes, place, speed, weak }, ... }   ({} if the app did not start this agent)
export const MODELS_PATH = "/mango/models/info"

/** The info of the models from the environment; a value that is not an object says nothing. */
export function modelsInfo(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const raw = env.MANGO_MODELS_INFO
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  console.warn("MANGO_MODELS_INFO is not a JSON object: the model menu has no details")
  return {}
}

export const modelsEffect = Effect.sync(() => HttpServerResponse.jsonUnsafe(modelsInfo()))
