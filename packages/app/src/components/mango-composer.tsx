// mango-code: above the composer, the line that says what the engine is doing now: a download, a load with its
// seconds, a start that failed, the cards lent, the other PC's engine that does not answer, no model on the computer
// (with the way to Models), a model just ready, the conversation read again. Only what the app's state says: never a
// promise.
import { createMediaQuery } from "@solid-primitives/media"
import { createMemo, createSignal, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { failureText, useMango } from "@/context/mango"
import { useSync } from "@/context/sync"
import { createEngineLive, createEngineTurn } from "@/components/engine-speed"
import { ownsEngineNumbers } from "@/utils/engine-speed"
import { noModel } from "@/utils/mango-state"
import { showToast } from "@/utils/toast"
import { statusLine } from "./mango-text"

const SEEN_KEY = "mango.readyHint.seen"
const storedSeen = () => {
  try {
    return localStorage.getItem(SEEN_KEY) === "1"
  } catch {
    // without storage it is said at each start, and «Got it» still closes it until the next
    return false
  }
}
// «X is ready», with where models change, is the explanation of the first time (shown once). Read with «Got it» or
// with a message sent, it does not come back, not after a restart either: a model ready later just ends its load.
const [readySeen, setReadySeen] = createSignal(storedSeen())

/** The model has just become ready and the explanation was never read: the line says it. */
export const showReady = (justReady: boolean) => justReady && !readySeen()

/** A narrow window (a phone) has no model name in the top bar and no gear in a conversation: the hint does not send there. */
export const readyHintKey = (narrow: boolean) =>
  narrow ? ("mango.status.readyHint.narrow" as const) : ("mango.status.readyHint" as const)

/** «X is ready» goes away for good, read with «Got it» or with a message sent. */
export function dismissReady(mango: Pick<ReturnType<typeof useMango>, "justReady" | "dismissReady">) {
  if (!mango.justReady()) return
  mango.dismissReady()
  setReadySeen(true)
  try {
    localStorage.setItem(SEEN_KEY, "1")
  } catch {}
}

export function MangoStatusLine(props: { sessionID?: string }) {
  const mango = useMango()
  const language = useLanguage()
  const sync = useSync()
  // the same width at which the top bar becomes the phone's (titlebar.tsx)
  const narrow = createMediaQuery("(max-width: 767px)")

  const working = createMemo(
    () => !!props.sessionID && (sync().data.session_status[props.sessionID]?.type ?? "idle") !== "idle",
  )
  const engine = createEngineLive(working)
  const turn = createEngineTurn(engine, () => props.sessionID)
  const reading = () => (working() && ownsEngineNumbers(turn()) ? engine().reading : undefined)

  const act = (action: () => Promise<void>) =>
    void action().catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("mango.use.failed"),
        description: failureText(error, language.t),
      }),
    )

  const line = createMemo(() => {
    const state = mango.state()
    if (!state) return
    return statusLine(
      {
        state,
        downloaded: mango.downloaded(),
        justReady: showReady(mango.justReady()),
        reading: reading(),
        empty: noModel(state, mango.catalog()),
      },
      language,
    )
  })
  const proposal = () => {
    const value = line()
    return value?.kind === "failed" ? value.proposal : null
  }
  const progress = () => {
    const value = line()
    return value?.kind === "text" ? value.progress : undefined
  }

  return (
    <Show when={line()}>
      {(current) => (
        <div
          role="status"
          data-component="mango-status"
          data-kind={current().kind}
          class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-[12px] leading-4 text-v2-text-text-muted"
        >
          <span>{current().text}</span>
          <Show when={progress() !== undefined}>
            <div
              role="progressbar"
              aria-label={current().text}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress()}
              class="h-1 w-24 overflow-hidden rounded-full bg-v2-background-bg-layer-01"
            >
              <div
                class="h-full rounded-full bg-v2-text-text-muted transition-[width]"
                style={{ width: `${progress()}%` }}
              />
            </div>
          </Show>
          <Show when={current().kind === "failed"}>
            <Show when={proposal()}>
              {(proposed) => (
                <ButtonV2
                  size="small"
                  variant="neutral"
                  data-action="mango-use-proposal"
                  onClick={() => act(() => mango.use(proposed().model, true))}
                >
                  {language.t("mango.action.useProposal", { model: proposed().label })}
                </ButtonV2>
              )}
            </Show>
            <ButtonV2 size="small" variant="ghost" data-action="mango-retry" onClick={() => act(() => mango.retry())}>
              {language.t("mango.action.retry")}
            </ButtonV2>
          </Show>
          <Show when={current().kind === "empty"}>
            <ButtonV2 size="small" variant="neutral" data-action="mango-choose-model" onClick={mango.openModels}>
              {language.t("mango.action.chooseModel")}
            </ButtonV2>
          </Show>
          <Show when={current().kind === "ready"}>
            <span class="text-v2-text-text-faint">{language.t(readyHintKey(narrow()))}</span>
            <ButtonV2
              size="small"
              variant="ghost"
              data-action="mango-ready-dismiss"
              onClick={() => dismissReady(mango)}
            >
              {language.t("mango.status.gotIt")}
            </ButtonV2>
          </Show>
        </div>
      )}
    </Show>
  )
}
