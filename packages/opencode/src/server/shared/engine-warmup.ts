import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync } from "node:fs"
import type { InstanceStore } from "@/project/instance-store"
import type { SessionPrompt } from "@/session/prompt"
import { tr } from "@/util/mango-language"

// mango-code: prepares the engine for a new conversation in the folder `?directory=`. It builds the request
// that conversation would send (system prompt and tools) and has the engine read it, which saves the base on
// disk; if the base is already there the engine answers at once and reads nothing. The app calls it during
// startup, before showing the page (see session/prompt.ts, `warmup`).
// Response: `{ directory, ready, promptTokens, promptMs, ... }`, `promptTokens` 0 = base already ready.
export const ENGINE_WARMUP_PATH = "/mango/warmup"

export function engineWarmupEffect(
  request: HttpServerRequest.HttpServerRequest,
  store: InstanceStore.Interface,
  prompt: SessionPrompt.Interface,
) {
  return Effect.gen(function* () {
    const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
    if (!directory) return HttpServerResponse.jsonUnsafe({ error: tr("manca directory", "directory is missing") }, { status: 400 })
    if (!existsSync(directory))
      return HttpServerResponse.jsonUnsafe(
        { name: "DirectoryNotFound", data: { message: `Directory not found: ${directory}`, directory } },
        { status: 404 },
      )
    return HttpServerResponse.jsonUnsafe(yield* store.provide({ directory }, prompt.warmup()))
  })
}
