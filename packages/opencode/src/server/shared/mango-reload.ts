import { Cause, Effect, Exit } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { InstanceStore } from "@/project/instance-store"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"

// mango-code: the app rewrote `opencode.json` (a model's context changed, the user added a model of their own) and asks
// the agent to read its configuration again. Reading it again means disposing every folder's
// instance, which interrupts an answer in progress: so it happens as soon as no conversation is answering, and until
// then the configuration before holds. A conversation stopped on a permission, a question or a retry is answering
// too. The route answers at once: 200 `{reloaded: true}` if it was read again now, 202 `{reloaded: false}` if it
// waits for the conversations, 500 if disposing failed. A prompt that arrives while the instances are being disposed
// waits for the new one (InstanceStore). Only for the app on this PC: the phone service stops it.
//   POST /mango/reload
export const RELOAD_PATH = "/mango/reload"

/** Watches the conversations from the start of the server: the reload needs to know which ones are answering. */
export const makeReload = Effect.gen(function* () {
  const store = yield* InstanceStore.Service
  const bridge = yield* EffectBridge.make()
  // The conversations answering (busy or waiting to retry), with their folder.
  const answering = new Map<string, string>()
  let pending = false
  const dispose = disposeAllInstancesAndEmitGlobalDisposed().pipe(Effect.provideService(InstanceStore.Service, store))

  const listener = (event: GlobalEvent) => {
    const payload = event.payload
    if (payload?.type === "session.status") {
      if (payload.properties.status.type === "idle") answering.delete(payload.properties.sessionID)
      else answering.set(payload.properties.sessionID, event.directory ?? "")
    }
    // A folder disposed for any reason has no conversation answering any more, also if it never said idle.
    if (payload?.type === "server.instance.disposed")
      for (const [session, directory] of answering) if (directory === payload.properties.directory) answering.delete(session)
    if (!pending || answering.size > 0) return
    pending = false
    // Not inside the publication of the event that ended the answer: the conversation finishes first.
    setTimeout(() => {
      if (answering.size > 0) {
        pending = true
        return
      }
      // Nobody waits for this answer: a failure goes to the log.
      bridge.fork(dispose.pipe(Effect.catchCause((cause) => Effect.logError("mango reload failed", { cause }))))
    })
  }
  GlobalBus.on("event", listener)
  yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

  return Effect.gen(function* () {
    if (answering.size > 0) {
      pending = true
      return HttpServerResponse.jsonUnsafe({ reloaded: false }, { status: 202 })
    }
    const exit = yield* Effect.exit(dispose)
    if (Exit.isFailure(exit))
      return HttpServerResponse.jsonUnsafe({ error: Cause.pretty(exit.cause) }, { status: 500 })
    return HttpServerResponse.jsonUnsafe({ reloaded: true })
  })
})
