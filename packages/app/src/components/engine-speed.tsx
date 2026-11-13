// mango-code: speed and timings of the local model.
//  - EngineSpeedBar: under the composer, "Reads 650 tokens/s · Writes 21 tokens/s", only while the model works;
//    at rest it is gone (the numbers stay under each answer).
//  - SessionWorkTime: in the header, the time the model spent working.
//  - TurnStats: under each answer, duration and tokens read/written.
// The numbers are the engine's (the same as its log): live from the server route, at the end of a
// step from the message. No estimates: where a measurement is missing nothing is shown.
// The route is polled only once even if the bar and the wait line are visible together.
// The engine serves one conversation at a time: the route's numbers belong to the active conversation
// and a queued conversation does not show them as its own (see `engineTurn`).
import { createEffect, createMemo, createResource, createSignal, onCleanup, Show, type Accessor } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createLiveNow } from "@opencode-ai/session-ui/live-now"
import { formatDuration } from "@opencode-ai/session-ui/step-time"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { authHeaders } from "@/utils/server"
import {
  formatRate,
  engineTurn,
  formatTokens,
  lastActivity,
  lastMeasured,
  MIN_READ_TOKENS,
  MIN_WRITE_TOKENS,
  olderWorkMs,
  ownsEngineNumbers,
  parseEngineQueue,
  parseLive,
  parseReading,
  parseWait,
  parseWorkSteps,
  readingRate,
  responseMs,
  sessionWorkMs,
  summarizeWork,
  tokensPerSecond,
  type EngineQueue,
  type EngineWait,
  type LiveTimings,
  type Reading,
  type Work,
} from "@/utils/engine-speed"

const ENGINE_SPEED_PATH = "/mango/engine/speed"
const SESSION_WORK_PATH = "/mango/session/work"
const POLL_MS = 1000

const [engineLive, setEngineLive] = createSignal<{ live?: LiveTimings; reading?: Reading; wait?: EngineWait; queue?: EngineQueue }>({})
let watchers = 0
let stopPolling: (() => void) | undefined

/** GET of a Mango Code route of the agent server; undefined if it is missing or does not answer. */
async function fetchServerJson(serverSDK: ReturnType<typeof useServerSDK>, path: string, timeoutMs: number) {
  const sdk = serverSDK()
  return fetch(new URL(path, sdk.url), { headers: authHeaders(sdk.server.http), signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => (response.ok ? response.json() : undefined))
    .catch(() => undefined)
}

function startPolling(serverSDK: ReturnType<typeof useServerSDK>) {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    // Server without the route or briefly stopped: the last measurements of the messages stay.
    const body = await fetchServerJson(serverSDK, ENGINE_SPEED_PATH, 10_000)
    if (stopped) return
    setEngineLive({ live: parseLive(body), reading: parseReading(body), wait: parseWait(body), queue: parseEngineQueue(body) })
    timer = setTimeout(tick, POLL_MS)
  }
  void tick()
  return () => {
    stopped = true
    clearTimeout(timer)
    setEngineLive({})
  }
}

/**
 * Live numbers of the stream in progress (write) and reading of the context in progress: it polls the
 * server only while at least one component has `active` true.
 */
export function createEngineLive(active: Accessor<boolean>) {
  const serverSDK = useServerSDK()
  createEffect(() => {
    if (!active()) return
    if (++watchers === 1) stopPolling = startPolling(serverSDK)
    onCleanup(() => {
      if (--watchers === 0) stopPolling?.()
    })
  })
  return engineLive
}

/** The role of a conversation with respect to the engine: active, queued behind another one, or other. */
export function createEngineTurn(engine: Accessor<{ queue?: EngineQueue }>, sessionID: Accessor<string | undefined>) {
  return createMemo(() => engineTurn(engine().queue ?? { waiting: [] }, sessionID()))
}

function useSessionData() {
  const sync = useSync()
  const { params } = useSessionLayout()
  const assistants = createMemo(() => {
    const id = params.id
    if (!id) return []
    return (sync().data.message[id] ?? []).filter((m): m is AssistantMessage => m.role === "assistant")
  })
  const working = createMemo(() => {
    const id = params.id
    return !!id && (sync().data.session_status[id]?.type ?? "idle") !== "idle"
  })
  return { assistants, working, session: () => (params.id ? sync().session.get(params.id) : undefined) }
}

/** Why the model does not answer yet: gpus on loan (to whom, since when) or model loading. */
export function waitLabel(wait: EngineWait, t: ReturnType<typeof useLanguage>["t"], locale: string) {
  if (wait.kind === "loading") return t("engine.wait.loading")
  const since = wait.since ? new Date(wait.since) : undefined
  const time =
    since && !Number.isNaN(since.getTime())
      ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(since)
      : undefined
  if (wait.who && time) return t("engine.wait.cards", { who: wait.who, time })
  return t("engine.wait.cardsUnknown")
}

export function EngineSpeedBar() {
  const language = useLanguage()
  const { assistants, working } = useSessionData()
  const { params } = useSessionLayout()
  const rawEngine = createEngineLive(working)
  const turn = createEngineTurn(rawEngine, () => params.id)
  // The live numbers are the engine's, which works for one conversation at a time: if it is working
  // for another one they are not this one's, and the bar is not shown.
  const live = () => working() && ownsEngineNumbers(turn())
  const engine = () => (live() ? rawEngine() : {})
  const measured = createMemo(() => lastMeasured(assistants()))
  const locale = () => language.intl()

  // While reading, the speed of this reading counts, not that of the last measured one.
  const read = () => {
    const reading = engine().reading
    if (reading) return readingRate(reading)
    const now = engine().live
    return (now && tokensPerSecond(now.promptTokens, now.promptMs, MIN_READ_TOKENS)) || measured().read?.rate
  }
  const write = () => {
    const now = engine().live
    return (now && tokensPerSecond(now.predictedTokens, now.predictedMs, MIN_WRITE_TOKENS)) || measured().write?.rate
  }
  // Before writing the model reads: without numbers for now, say so instead of staying silent.
  const reading = () => live() && !engine().live && read() === undefined

  // The engine does not answer because the gpus are lent to another app or the model is loading: say so.
  const waitText = () => {
    const wait = engine().wait
    return wait && waitLabel(wait, language.t, locale())
  }

  const readText = () => {
    const rate = read()
    if (rate !== undefined) return language.t("engine.speed.read", { rate: formatRate(rate, locale()) })
    if (waitText()) return waitText()
    if (reading()) return language.t("engine.speed.readPending")
  }
  const writeText = () => {
    const rate = write()
    if (rate !== undefined) return language.t("engine.speed.write", { rate: formatRate(rate, locale()) })
  }

  return (
    <Show when={live() && (readText() || writeText())}>
      <TooltipV2
        placement="top"
        value={
          <div class="flex max-w-[280px] flex-col gap-1.5">
            <span>{language.t("engine.speed.tooltip.read")}</span>
            <span>{language.t("engine.speed.tooltip.write")}</span>
            <span class="text-v2-text-text-muted">{language.t("engine.speed.tooltip.unit")}</span>
          </div>
        }
      >
        <div
          data-component="engine-speed"
          class="mt-1 flex w-fit mx-auto items-center gap-2 text-[12px] leading-4 tabular-nums text-v2-text-text-muted cursor-default select-none"
        >
          <Show when={readText()}>{(text) => <span>{text()}</span>}</Show>
          <Show when={readText() && writeText()}>
            <span class="text-v2-text-text-faint">·</span>
          </Show>
          <Show when={writeText()}>{(text) => <span>{text()}</span>}</Show>
        </div>
      </TooltipV2>
    </Show>
  )
}

function Breakdown(props: { work: Work }) {
  const language = useLanguage()
  const time = (ms: number) => formatDuration(ms, language.t)
  const other = () => Math.max(0, props.work.wallMs - props.work.modelMs)
  return (
    <>
      <span>
        {language.t("engine.breakdown.model", {
          time: time(props.work.modelMs),
          read: time(props.work.readMs),
          write: time(props.work.writeMs),
        })}
      </span>
      <Show when={other() >= 1000}>
        <span>{language.t("engine.breakdown.other", { time: time(other()) })}</span>
      </Show>
    </>
  )
}

export function SessionWorkTime() {
  const language = useLanguage()
  const sync = useSync()
  const serverSDK = useServerSDK()
  const { assistants, working, session } = useSessionData()
  const { params } = useSessionLayout()
  const now = createLiveNow(working)
  // The page keeps only the latest answers in memory: the older steps come from the server.
  const [steps] = createResource(
    () => params.id,
    async (id) => parseWorkSteps(await fetchServerJson(serverSDK, `${SESSION_WORK_PATH}?sessionID=${encodeURIComponent(id)}`, 5000)),
  )
  // Only once it has arrived: before that `steps.latest` suspends the whole conversation, and after a
  // failure it throws the error into it.
  const older = createMemo(() =>
    olderWorkMs(
      steps.state === "ready" || steps.state === "refreshing" ? (steps.latest ?? []) : [],
      assistants().map((message) => message.id),
    ),
  )
  const total = createMemo(
    () =>
      older() +
      sessionWorkMs(assistants(), working(), now(), (message) => lastActivity(sync().data.part[message.id])),
  )
  // The read/write detail comes from the engine timings, which the older steps do not have:
  // it is shown only if they cover the whole conversation.
  const work = createMemo(() => {
    const value = summarizeWork(assistants(), now())
    return value && older() === 0 ? value : undefined
  })
  const open = () => {
    const created = session()?.time.created
    return typeof created === "number" ? Math.max(0, now() - created) : undefined
  }

  return (
    <Show when={total() >= 1000}>
      <TooltipV2
        placement="bottom"
        value={
          <div class="flex max-w-[280px] flex-col gap-1.5">
            <span>{language.t("engine.work.tooltip")}</span>
            <Show when={work()}>{(value) => <Breakdown work={value()} />}</Show>
            <Show when={open()}>
              {(ms) => (
                <span class="text-v2-text-text-muted">
                  {language.t("engine.work.since", { time: formatDuration(ms(), language.t) })}
                </span>
              )}
            </Show>
          </div>
        }
      >
        <span
          data-component="session-work-time"
          class="hidden shrink-0 cursor-default select-none px-1 text-[12px] leading-4 tabular-nums text-v2-text-text-faint sm:inline"
        >
          {language.t("engine.work.label", { time: formatDuration(total(), language.t) })}
        </span>
      </TooltipV2>
    </Show>
  )
}

/** Line under a finished answer: duration and tokens read/written, with the speeds where they are measured. */
export function TurnStats(props: { messages: readonly AssistantMessage[] }) {
  const language = useLanguage()
  const work = createMemo(() => summarizeWork(props.messages, Date.now()))
  const duration = createMemo(() => responseMs(props.messages))
  const locale = () => language.intl()

  const part = (key: "engine.turn.read" | "engine.turn.write", tokens: number, rate: number | undefined) => {
    const text = language.t(key, { tokens: formatTokens(tokens, locale()) })
    return rate === undefined ? text : `${text} ${language.t("engine.turn.rate", { rate: formatRate(rate, locale()) })}`
  }

  return (
    <Show when={work()}>
      {(value) => (
        <TooltipV2
          placement="top"
          value={
            <div class="flex max-w-[300px] flex-col gap-1.5">
              <Show when={duration()}>
                {(ms) => <span>{language.t("engine.turn.duration", { time: formatDuration(ms(), language.t) })}</span>}
              </Show>
              <Breakdown work={value()} />
              <Show when={value().steps > 1}>
                <span class="text-v2-text-text-muted">{language.t("engine.turn.steps", { count: value().steps })}</span>
              </Show>
            </div>
          }
        >
          <div
            data-component="turn-stats"
            class="flex w-fit flex-wrap items-center gap-x-2 text-[12px] leading-4 tabular-nums text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted cursor-default select-none"
          >
            <Show when={duration()}>{(ms) => <span>{formatDuration(ms(), language.t)}</span>}</Show>
            <span>{part("engine.turn.read", value().readTokens, value().readRate)}</span>
            <span>{part("engine.turn.write", value().writeTokens, value().writeRate)}</span>
          </div>
        </TooltipV2>
      )}
    </Show>
  )
}
