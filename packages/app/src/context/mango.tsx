// mango-code: the model, the downloads and the catalog of the app, read from the agent, and the
// messages that wait for the model. One for the whole interface: the bar, the Home, the composer, the menus and the
// status line show the same state, read every second while something is changing and every five seconds otherwise.
// It is the only reader of `/mango/state`, `/mango/models` and `/mango/computer`. Without the app behind (an agent
// started by hand) the routes answer 503 and nothing of this is shown.
import { batch, createEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePlatform, type Platform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { onLanguageSaved, useLanguage } from "@/context/language"
import { useOpenSettings } from "@/components/settings-page/open"
import { sendFollowupDraft, type FollowupDraft } from "@/components/prompt-input/submit"
import { promptLength } from "@/components/prompt-input/history"
import type { usePrompt } from "@/context/prompt"
import { authHeaders } from "@/utils/server"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { MANGO_PROVIDER } from "@/utils/model-info"
import { batches, combine, joinPrompts, RUN, split, withTimeout, type PendingItem } from "@/utils/mango-pending"
import { Identifier } from "@/utils/id"
import {
  becameReady,
  canSend,
  newer,
  parseCatalog,
  parseComputer,
  parseState,
  pollDelay,
  type CatalogEntry,
  type Computer,
  type MangoState,
} from "@/utils/mango-state"
import { onWhere } from "@/components/mango-text"

/** Reads in a row without an answer after which the state is no longer shown: it would be old. */
const MAX_FAILURES = 3
/** Tries for the waiting messages of a conversation, one at each read of the state, before they say they did not leave. */
export const MAX_TRIES = 3
/** How long a waiting message may take to reach the agent before the try counts as failed. */
const SEND_TIMEOUT_MS = 60_000

let pending: ReturnType<typeof createPending> | undefined
let reader: ReturnType<typeof createReader> | undefined

/** A sentence of the app for the user: what it answered when it refused. */
export class MangoRefusal extends Error {}

type Agent = { url: string; http: { username?: string; password?: string } }

/** A request to one of the agent's Mango routes. It fails with the app's sentence, or with no sentence at all. */
async function call(agent: Agent, path: string, init?: { method?: string; body?: unknown }) {
  const response = await fetch(new URL(path, agent.url), {
    method: init?.method,
    headers: {
      ...authHeaders(agent.http),
      // the agent takes a POST to these routes only as JSON, one without a body too
      ...(init?.method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => undefined)
  if (response.ok) return body
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message
  if (typeof message === "string" && message) throw new MangoRefusal(message)
  throw new Error(`${response.status}`)
}

/**
 * The state, the catalog and the computer as the agent tells them, read in a loop until its owner is disposed. An answer
 * older than the one shown is left out; after `MAX_FAILURES` reads without an answer nothing is shown; the catalog and
 * the computer are read again when the catalog's revision changes, and at every read until they have come.
 */
export function createReader(agent: () => Agent) {
  const [state, setState] = createSignal<MangoState>()
  const [catalog, setCatalog] = createSignal<CatalogEntry[]>()
  const [computer, setComputer] = createSignal<Computer>()
  // The computer did not read the last time it was asked: it is asked again at every read.
  const [computerFailed, setComputerFailed] = createSignal(false)
  // The catalog answered, but none of its models read: the interface says it cannot read them, and asks again.
  const [catalogFailed, setCatalogFailed] = createSignal(false)
  // The models seen downloading: their load says «Downloaded.» until it ends.
  const [downloaded, setDownloaded] = createSignal<ReadonlySet<string>>(new Set())
  // A model that has just become ready says where it runs, until the user has read it or sends a message.
  const [justReady, setJustReady] = createSignal(false)
  // The model asked with «use», while the app answers.
  const [asked, setAsked] = createSignal<string>()
  const [failures, setFailures] = createSignal(0)
  // A read went unanswered since the state shown: the app may have started again, its revision counting from zero.
  let gap = false
  let catalogRevision: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let stopped = false
  const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden"

  const apply = (next: MangoState) => {
    const shown = state()
    if (!gap && !newer(shown, next)) return
    gap = false
    batch(() => {
      const model = next.model
      const ended = (model.phase === "ready" || model.phase === "failed") && model.model
      const active = next.downloads.filter((d) => d.state === "active").map((d) => d.model)
      const seen = downloaded()
      const kept = [...new Set([...seen, ...active])].filter((key) => key !== ended)
      if (kept.length !== seen.size || kept.some((key) => !seen.has(key))) setDownloaded(new Set(kept))
      if (becameReady(shown, next)) setJustReady(true)
      if (model.phase !== "ready") setJustReady(false)
      setState(next)
    })
  }
  const readState = async () => {
    const next = await call(agent(), "/mango/state").then(parseState, () => undefined)
    setFailures(next ? 0 : failures() + 1)
    if (!next) gap = true
    if (next) apply(next)
    // An app that stopped answering is not shown as it was: the bar, the Home and the line go away.
    if (failures() >= MAX_FAILURES) setState(undefined)
    return next
  }
  // Only the answer to the last request of the catalog, and of the computer, is shown: an earlier one that arrives later
  // (a read of the loop under way when the language changed) says what was true before.
  let catalogAsked = 0
  let computerAsked = 0
  // The revision is kept only once the catalog is read: one that did not come is asked again at the next read.
  const readCatalog = (revision: number) => {
    const asked = ++catalogAsked
    return Promise.all([
      call(agent(), "/mango/models").then(
        (body) => {
          if (asked !== catalogAsked) return
          const next = parseCatalog(body)
          if (!next && !catalogFailed()) console.error("/mango/models: none of the models could be read")
          setCatalogFailed(!next)
          if (!next) return
          setCatalog(next)
          catalogRevision = revision
        },
        () => undefined,
      ),
      readComputer(),
    ])
  }
  // The log says why the computer does not read, once until it reads again.
  const readComputer = () => {
    const asked = ++computerAsked
    return call(agent(), "/mango/computer")
      .then((body) => parseComputer(body) ?? Promise.reject(new Error("/mango/computer: unexpected answer")))
      .then(
        (next) => {
          if (asked !== computerAsked) return
          batch(() => {
            setComputer(next)
            setComputerFailed(false)
          })
        },
        (cause: unknown) => {
          if (asked !== computerAsked) return
          if (!computerFailed()) console.error(`the computer could not be read: ${String(cause)}`)
          setComputerFailed(true)
        },
      )
  }
  // After the state: the catalog, with the computer, when its revision changed or it has not read; otherwise the computer
  // until it reads.
  const readRest = (next: MangoState) => {
    if (next.catalog_revision !== catalogRevision || catalog() === undefined) return readCatalog(next.catalog_revision)
    if (computerFailed() || computer() === undefined) return readComputer()
  }
  const tick = async () => {
    if (reading || stopped) return
    reading = true
    clearTimeout(timer)
    const next = await readState()
    if (next) await readRest(next)
    reading = false
    if (!stopped) timer = setTimeout(tick, pollDelay(state(), { hidden: hidden(), failures: failures() }))
  }
  const visible = () => {
    if (!hidden()) void tick()
  }
  /** Reads the state, the catalog and the computer now. */
  const refresh = async () => {
    const next = await readState()
    if (next) await readCatalog(next.catalog_revision)
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible)
  // The app's sentences (verdicts, where a model runs, the computer) are in the language of the moment they are read.
  const offLanguage = onLanguageSaved(() => void refresh())
  onCleanup(() => {
    stopped = true
    clearTimeout(timer)
    offLanguage()
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible)
  })
  void tick()

  return {
    state,
    catalog,
    computer,
    computerFailed,
    catalogFailed,
    /** No state is shown and the last read of it had no answer (an agent without the app behind, or the app gone). */
    failed: () => failures() > 0 && state() === undefined,
    downloaded,
    justReady,
    /** The user has read «X is ready», or writes. */
    dismissReady: () => setJustReady(false),
    asked,
    /** Reads the state, the catalog and the computer now: after a command of the bridge, or when a menu opens. */
    refresh,
    /** Uses this model now: the load in progress stops. What the model was and is now, for the notice. */
    async use(model: string, once?: boolean) {
      const before = state()?.model
      setAsked(model)
      try {
        const next = parseState(
          await call(agent(), "/mango/model/use", { method: "POST", body: once ? { model, once } : { model } }),
        )
        // shown before «asked» goes: the conversation's model then meets the engine's new one
        if (next) apply(next)
        return { before, now: next?.model }
      } finally {
        setAsked(undefined)
      }
    },
    async retry() {
      const next = parseState(await call(agent(), "/mango/model/retry", { method: "POST" }))
      if (next) apply(next)
    },
  }
}

export function createPending(platform: Platform) {
  return createRoot(() => {
    const [store, setStore, , ready] = persisted(
      Persist.global("mango.pending.v1"),
      createStore<{ items: Record<string, PendingItem[] | undefined> }>({ items: {} }),
      platform,
    )
    // How each conversation's messages are leaving, as the bubbles show it: being sent now, the tries that did not go.
    const [delivery, setDelivery] = createStore<Record<string, { sending: boolean; tries: number }>>({})
    // The state read when the last try failed (the next try waits for another read), and the group being sent with its
    // message id, kept across tries so that a message that reached the agent is not sent again.
    const failedAt = new Map<string, MangoState | undefined>()
    const attempts = new Map<string, { messageID: string; ids: string[] }>()
    const info = (sessionID: string) => untrack(() => delivery[sessionID])
    let couldSend = false
    const waiting = (sessionID: string) => split(store.items[sessionID], RUN).waiting
    const sessions = () => Object.keys(store.items).filter((id) => waiting(id).length > 0)
    const sending = (sessionID: string) => delivery[sessionID]?.sending === true
    const local = (sessionID: string) => waiting(sessionID).at(-1)?.draft.model.providerID === MANGO_PROVIDER
    const remove = (sessionID: string, ids: string[]) =>
      setStore(
        produce((draft) => {
          const left = (draft.items[sessionID] ?? []).filter((item) => !ids.includes(item.id))
          if (left.length) {
            draft.items[sessionID] = left
            return
          }
          delete draft.items[sessionID]
        }),
      )
    return {
      ready,
      /** The messages of this start waiting in a conversation, in the order they were sent. */
      waiting,
      /** The conversations with messages of this start waiting. */
      sessions,
      /** The conversation's messages are being sent: they cannot go back to the box. */
      sending,
      /** They were tried `MAX_TRIES` times and did not leave: the bubble says so, with «Retry». */
      stuck: (sessionID: string) => !sending(sessionID) && (delivery[sessionID]?.tries ?? 0) >= MAX_TRIES,
      /** «Retry»: they are tried again at the next read of the state. */
      retry: (sessionID: string) => {
        failedAt.delete(sessionID)
        setDelivery(sessionID, { sending: false, tries: 0 })
      },
      add(draft: FollowupDraft) {
        const item: PendingItem = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          run: RUN,
          draft,
        }
        setStore("items", draft.sessionID, (items) => [...(items ?? []), item])
      },
      remove,
      /** The X: the message leaves the wait and goes back into its box (`takeEarlier`), never while it is being sent. */
      restore(item: PendingItem) {
        if (sending(item.draft.sessionID)) return
        setStore("items", item.draft.sessionID, (items) =>
          (items ?? []).map((other) => (other.id === item.id ? { ...other, run: "" } : other)),
        )
      },
      /** The user chose another model for the conversation: its waiting messages leave with it. */
      retarget(sessionID: string, model: FollowupDraft["model"]) {
        setStore("items", sessionID, (items) =>
          (items ?? []).map((item) => (item.run === RUN ? { ...item, draft: { ...item.draft, model } } : item)),
        )
      },
      /** The messages to put back in the box: those of an earlier start and those taken back with the X. */
      takeEarlier(sessionID: string) {
        const earlier = structuredClone(unwrap(split(store.items[sessionID], RUN).earlier))
        if (earlier.length)
          remove(
            sessionID,
            earlier.map((item) => item.id),
          )
        return earlier
      },
      /**
       * Sends what can leave now: each conversation's waiting messages in order, those written one after the other as one
       * message and a «/» command by itself. They go to the model ready here or to the other PC's engine that answers;
       * those moved to a model of another provider go at once. What does not go is tried again at a later read of the
       * state (`current` another object), `MAX_TRIES` times; the tries of the messages for this PC's models start again
       * when its model stops being ready. A send that does not end in `SEND_TIMEOUT_MS` counts as failed. Run in an
       * effect, it runs again at each read of the state and when a message is added, moved to another model or sent.
       */
      deliver(
        current: MangoState | undefined,
        send: (draft: FollowupDraft, messageID: string) => Promise<unknown>,
        onGiveUp: (error: unknown) => void,
      ) {
        const now = canSend(current)
        const left = couldSend && !now
        couldSend = now
        const model = current?.model
        const ready = model?.phase === "ready" ? { providerID: MANGO_PROVIDER, modelID: model.model } : undefined
        for (const sessionID of sessions()) {
          const elsewhere = !local(sessionID)
          const was = info(sessionID)
          if (left && !elsewhere && was && !was.sending) {
            failedAt.delete(sessionID)
            setDelivery(sessionID, { tries: 0 })
          }
          const at = info(sessionID)
          if (
            at?.sending ||
            (at?.tries ?? 0) >= MAX_TRIES ||
            (failedAt.has(sessionID) && failedAt.get(sessionID) === current)
          )
            continue
          if (!elsewhere && !now) continue
          // what follows only acts: nothing it reads may run the effect again
          untrack(() => start(sessionID, at?.tries ?? 0))
        }
        function start(sessionID: string, tries: number) {
          setDelivery(sessionID, { sending: true, tries })
          const sendAll = async () => {
            for (
              let items = untrack(() => waiting(sessionID));
              items.length > 0;
              items = untrack(() => waiting(sessionID))
            ) {
              const kept = attempts.get(sessionID)
              const attempt =
                kept && kept.ids.every((id) => items.some((item) => item.id === id))
                  ? kept
                  : { messageID: Identifier.ascending("message"), ids: batches(items)[0].map((item) => item.id) }
              attempts.set(sessionID, attempt)
              const group = items.filter((item) => attempt.ids.includes(item.id))
              await withTimeout(send(combine(group, ready)!, attempt.messageID), SEND_TIMEOUT_MS)
              attempts.delete(sessionID)
              remove(sessionID, attempt.ids)
            }
          }
          void sendAll().then(
            () => {
              failedAt.delete(sessionID)
              setDelivery(sessionID, { sending: false, tries: 0 })
            },
            (error: unknown) => {
              const tries = (info(sessionID)?.tries ?? 0) + 1
              failedAt.set(sessionID, current)
              setDelivery(sessionID, { sending: false, tries })
              if (tries >= MAX_TRIES) onGiveUp(error)
            },
          )
        }
      },
    }
  }, undefined)
}

export function useMango() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const openSettings = useOpenSettings()
  // one for the whole interface, for as long as it lives
  reader ??= createRoot(() => createReader(() => ({ url: serverSDK().url, http: serverSDK().server.http })))
  pending ??= createPending(platform)
  const read = reader
  const waiting = pending
  return {
    state: read.state,
    catalog: read.catalog,
    computer: read.computer,
    computerFailed: read.computerFailed,
    catalogFailed: read.catalogFailed,
    failed: read.failed,
    downloaded: read.downloaded,
    justReady: read.justReady,
    dismissReady: read.dismissReady,
    /** The model asked with «use» while the app answers. */
    asked: read.asked,
    pending: waiting,
    /** The app is behind the agent: its routes answer. */
    available: () => read.state() !== undefined,
    /** The bridge of the app's window: what changes the computer goes through it. */
    bridge: () => (typeof window === "undefined" ? undefined : window.__MANGO_DESKTOP__),
    refresh: read.refresh,
    /**
     * Uses this model now: the load in progress stops, and a notice says which and where the new one loads.
     * `once`: the model proposed after a failed start.
     */
    async use(model: string, once?: boolean) {
      const { before, now } = await read.use(model, once)
      if (before?.phase !== "loading" || before.model === model || now?.phase !== "loading") return
      const where = now.where ?? read.catalog()?.find((m) => m.key === model)?.verdict.where
      showToast({
        description: where
          ? language.t("mango.switched.where", { from: before.label, to: now.label, where: onWhere(where, language) })
          : language.t("mango.switched", { from: before.label, to: now.label }),
      })
    },
    retry: read.retry,
    /** The settings, on Models. */
    openModels: () => openSettings("models"),
    /** The settings, on Models at this model's row: its own, or the one of its download. */
    openModelRow: (key: string) => openSettings("models", key),
    /** The settings, on Models at «Another model»: a model from Hugging Face or a file of the computer. */
    openOtherModel: () => openSettings("models", language.t("settings.models.other.title")),
    /** The settings, on Help: «Report the problem» with the user's note. */
    openHelp: () => openSettings("help"),
  }
}

/** What a failure says to the user: the app's sentence, or ours when the app did not answer. */
export function failureText(cause: unknown, t: ReturnType<typeof useLanguage>["t"]) {
  return cause instanceof MangoRefusal ? cause.message : t("mango.error.noAnswer")
}

/**
 * When the model is ready the waiting messages of each conversation leave (`deliver`), whatever screen is open. One
 * that does not leave after its tries says so in its bubble, and once in a notice.
 */
export function useMangoPendingSender(onGiveUp: (error: unknown) => void) {
  const mango = useMango()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  // The agent takes the same message id again as a new turn (it rewrites the message, adds its parts again and answers
  // again): a try after one whose answer was lost first looks whether the message is already in the conversation.
  const send = (draft: FollowupDraft, messageID: string) =>
    new Promise<unknown>((resolve, reject) =>
      createRoot((dispose) => {
        const sdk = serverSDK().ensureDirSdkContext(draft.sessionDirectory)
        const sync = serverSync().ensureDirSyncContext(draft.sessionDirectory)
        if ((sync.data.message[draft.sessionID] ?? []).some((message) => message.id === messageID)) {
          dispose()
          return resolve(true)
        }
        void sendFollowupDraft({
          api: sdk.api.session,
          sync,
          serverSync: serverSync(),
          draft,
          messageID,
          optimisticBusy: true,
        })
          .then(resolve, reject)
          .finally(dispose)
      }),
    )
  return () => mango.pending.deliver(mango.state(), send, onGiveUp)
}

type Box = Pick<ReturnType<typeof usePrompt>, "current" | "set"> & {
  context: Pick<ReturnType<typeof usePrompt>["context"], "add">
}

/**
 * The box of a conversation takes back its messages that no longer wait: those of an earlier start of the app,
 * when the conversation is first opened, and the one whose X was pressed. They go before what is being written, in
 * order, with their context; nothing of them leaves by itself.
 */
export function bringBackPending(input: {
  sessionID: () => string | undefined
  pending: Pick<ReturnType<typeof createPending>, "ready" | "takeEarlier">
  prompt: Box
  /** Nothing is written in the box. */
  blank: () => boolean
  focus: () => void
}) {
  createEffect(() => {
    const id = input.sessionID()
    if (!id || !input.pending.ready()) return
    const items = input.pending.takeEarlier(id)
    if (items.length === 0) return
    untrack(() => {
      const typed = input.blank() ? [] : [input.prompt.current()]
      const next = joinPrompts([...items.map((item) => item.draft.prompt), ...typed])
      items
        .flatMap((item) => item.draft.context)
        .forEach((item) =>
          input.prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          }),
        )
      input.prompt.set(next, promptLength(next))
      input.focus()
    })
  })
}
