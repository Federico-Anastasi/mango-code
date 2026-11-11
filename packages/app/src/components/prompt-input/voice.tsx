// mango-code: live dictation, entirely local.
// The microphone is read at 16 kHz, PCM is sent to the machine's service while speaking and the
// service answers with the partials (visible right next to the microphone) and the final
// sentences (which end up in the message field). No Web Speech API, which in Chrome sends the
// audio to Google's servers. No keyboard shortcut: the space bar stays a key.
import { createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { ServerConnection } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"
import {
  formatVoiceDuration,
  voiceFailureFromMediaError,
  VOICE_MAX_RECORDING_SECONDS,
  type VoiceFailure,
  type VoiceFailureKind,
} from "./dictation"
import { dictationState, showDictationHint } from "@/utils/dictation-state"
import { inMangoDesktop, type MangoDictationState } from "@/utils/mango-desktop"
import { useSettingsDialog } from "@/components/settings-dialog"

export const VOICE_LIVE_START_PATH = "/mango/voice/live/start"
export const VOICE_LIVE_PCM_PATH = "/mango/voice/live/pcm"
export const VOICE_LIVE_END_PATH = "/mango/voice/live/end"

const SAMPLE_RATE = 16_000
/** How often the audio is sent to the service: half a second is already "live" and costs little. */
const SEND_MS = 450
/** If the service is slower than the speech, audio piles up, but not forever: the latest is kept. */
const MAX_BUFFERED = 8

export type VoiceState = "idle" | "starting" | "listening" | "ending"

export type VoiceEvent = { type: string; text?: string; message?: string }

/** Below this peak (about -46 dBFS) the microphone sent silence: muted, or not the one Windows uses. */
const SILENT_PEAK = 0.005

/** Float32 [-1,1] → 16-bit little-endian PCM, as the service wants it. */
function toPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}

export function createVoiceDictation(input: {
  start: () => Promise<string>
  pcm: (id: string, audio: ArrayBuffer) => Promise<VoiceEvent[]>
  end: (id: string) => Promise<VoiceEvent[]>
  onText: (text: string) => void
  /** The sentence in progress, to show where the text goes; it is replaced by the next one or by `onText`. */
  onPartial: (text: string) => void
  /** The sentence in progress ended without text: what `onPartial` showed goes away. */
  onClear: () => void
  onError: (failure: VoiceFailure) => void
}) {
  const [state, setState] = createSignal<VoiceState>("idle")
  const [elapsed, setElapsed] = createSignal(0)
  let context: AudioContext | undefined
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let processor: ScriptProcessorNode | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let tick: ReturnType<typeof setInterval> | undefined
  let id: string | undefined
  let buffered: Uint8Array[] = []
  let sending = false
  // The last send failed: the audio waits for the next one and the failure is reported only once.
  let failing = false
  let disposed = false
  // Whether this recording produced any text, and the loudest sample the microphone sent: at the end, a recording
  // without text says why (silence from the microphone, or no words recognized) instead of ending in nothing.
  let heard = false
  let peak = 0

  const handle = (events: VoiceEvent[]) => {
    for (const event of events) {
      if (event.type === "partial" && event.text) input.onPartial(event.text)
      else if (event.type === "final" && event.text?.trim()) {
        heard = true
        input.onText(event.text.trim())
      } else if (event.type === "empty") input.onClear()
      else if (event.type === "error") input.onError({ kind: "service", detail: event.message })
    }
  }

  /** Sends what has piled up. One request at a time: if one is in flight, wait. */
  const flush = async () => {
    if (!id || sending || buffered.length === 0) return
    sending = true
    const chunks = buffered
    buffered = []
    const audio = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
      audio.set(chunk, at)
      at += chunk.length
    }
    try {
      handle(await input.pcm(id, audio.buffer))
      failing = false
    } catch {
      buffered = [...chunks, ...buffered].slice(-MAX_BUFFERED)
      if (!failing) input.onError({ kind: "service" })
      failing = true
    } finally {
      sending = false
    }
  }

  const release = () => {
    if (timer) clearInterval(timer)
    if (tick) clearInterval(tick)
    timer = undefined
    tick = undefined
    processor?.disconnect()
    source?.disconnect()
    processor = undefined
    source = undefined
    void context?.close().catch(() => {})
    context = undefined
    stream?.getTracks().forEach((track) => track.stop())
    stream = undefined
  }

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      input.onError({ kind: "unsupported" })
      return
    }
    setState("starting")
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (error) {
      release()
      setState("idle")
      input.onError(voiceFailureFromMediaError(error))
      return
    }
    if (disposed) {
      release()
      return
    }
    let session: string
    try {
      session = await input.start()
    } catch {
      release()
      setState("idle")
      input.onError({ kind: "service" })
      return
    }
    if (disposed) {
      // the page closed while the service was starting: the cleanup had no session to close yet
      void input.end(session).catch(() => {})
      return
    }
    id = session

    // At 16 kHz the browser resamples by itself: the service does not have to.
    context = new AudioContext({ sampleRate: SAMPLE_RATE })
    source = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(4096, 1, 1)
    heard = false
    peak = 0
    processor.onaudioprocess = (event) => {
      if (disposed) return
      const samples = event.inputBuffer.getChannelData(0)
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
      buffered.push(toPcm16(samples))
      if (buffered.length > MAX_BUFFERED) buffered.shift()
    }
    // The processor must be connected to receive the audio; the output stays silent (we do not
    // write to it), so the microphone is not played back through the speakers.
    source.connect(processor)
    processor.connect(context.destination)

    const begin = Date.now()
    setElapsed(0)
    timer = setInterval(() => {
      const seconds = (Date.now() - begin) / 1000
      setElapsed(seconds)
      if (seconds < VOICE_MAX_RECORDING_SECONDS) return
      input.onError({ kind: "limit" })
      void stop()
    }, 250)
    tick = setInterval(() => void flush(), SEND_MS)
    setState("listening")
  }

  const stop = async () => {
    if (state() !== "listening") return
    setState("ending")
    release()
    // The last accumulated audio must arrive before closing, otherwise the tail is lost.
    for (let attempt = 0; attempt < 40 && sending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await flush()
    const session = id
    id = undefined
    if (session) {
      try {
        handle(await input.end(session))
        if (!heard) input.onError({ kind: peak < SILENT_PEAK ? "silent" : "empty" })
      } catch {
        input.onError({ kind: "service" })
      }
    }
    // a partial without its final sentence does not stay in the prompt
    input.onClear()
    setState("idle")
  }

  // Closing the page while dictation is open turns the microphone off and closes the session:
  // no text arrives in a prompt that is no longer there.
  onCleanup(() => {
    disposed = true
    release()
    const session = id
    id = undefined
    if (session) void input.end(session).catch(() => {})
  })

  return {
    state,
    elapsed,
    toggle() {
      if (state() === "idle") void start()
      else if (state() === "listening") void stop()
    },
  }
}

async function voiceRequest(
  server: ServerConnection.HttpBase,
  base: string,
  path: string,
  body: ArrayBuffer | undefined,
  unreachable: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {}
  if (body) headers["content-type"] = "application/octet-stream"
  if (server.password)
    headers.authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
  const response = await fetch(new URL(path, base), {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(path.startsWith(VOICE_LIVE_START_PATH) ? 120_000 : 30_000),
  }).catch(() => {
    throw new Error(unreachable)
  })
  const payload: unknown = await response.json().catch(() => undefined)
  const field = (key: string) =>
    payload && typeof payload === "object" && key in payload ? (payload as Record<string, unknown>)[key] : undefined
  if (!response.ok) {
    const message = field("error")
    throw new Error(typeof message === "string" ? message : `${unreachable} (HTTP ${response.status})`)
  }
  return (payload as Record<string, unknown>) ?? {}
}

function voiceEvents(payload: Record<string, unknown>): VoiceEvent[] {
  return Array.isArray(payload.events) ? (payload.events as VoiceEvent[]) : []
}

export function PromptVoiceButton(props: {
  onText: (text: string) => void
  onPartial: (text: string) => void
  onClear: () => void
  disabled?: boolean
}) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const messages: Record<VoiceFailureKind, () => string> = {
    unsupported: () => language.t("prompt.voice.error.unsupported"),
    "no-device": () => language.t("prompt.voice.error.noDevice"),
    // inside the app the permission belongs to Windows, not to the site
    denied: () => language.t(inMangoDesktop() ? "prompt.voice.error.denied.app" : "prompt.voice.error.denied"),
    busy: () => language.t("prompt.voice.error.busy"),
    service: () => language.t("prompt.voice.error.service"),
    empty: () => language.t("prompt.voice.error.empty"),
    silent: () => language.t("prompt.voice.error.silent"),
    limit: () => language.t("prompt.voice.error.limit"),
    timeout: () => language.t("prompt.voice.error.timeout"),
  }
  const call = (path: string, body?: ArrayBuffer) => {
    const sdk = serverSDK()
    return voiceRequest(sdk.server.http, sdk.url, path, body, language.t("prompt.voice.error.service"))
  }
  const voice = createVoiceDictation({
    start: async () => String((await call(VOICE_LIVE_START_PATH)).id ?? ""),
    pcm: async (id, audio) => voiceEvents(await call(`${VOICE_LIVE_PCM_PATH}?id=${encodeURIComponent(id)}`, audio)),
    end: async (id) => voiceEvents(await call(`${VOICE_LIVE_END_PATH}?id=${encodeURIComponent(id)}`)),
    onText: props.onText,
    onPartial: props.onPartial,
    onClear: props.onClear,
    onError: (failure) =>
      showToast({
        variant: failure.kind === "empty" || failure.kind === "limit" ? undefined : "error",
        title: language.t("prompt.voice.title"),
        description: failure.kind === "service" && failure.detail ? failure.detail : messages[failure.kind](),
      }),
  })
  // The button does not take focus with the mouse (it stays in the message field) and the
  // space bar never activates it: in the web UI space just types a space.
  const guard = {
    onMouseDown: (event: MouseEvent) => event.preventDefault(),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === " ") event.preventDefault()
    },
    onKeyUp: (event: KeyboardEvent) => {
      if (event.key === " ") event.preventDefault()
    },
  }
  // In the app the dictation is the user's choice: until it is ready the button leads to where it is turned on, and says so.
  const settings = useSettingsDialog("general")
  const dictation = dictationState()
  const notReady = () => {
    const current = dictation()
    return current?.status === "ready" ? undefined : current
  }
  const explain = (current: MangoDictationState) =>
    current.status === "off"
      ? language.t("prompt.voice.off")
      : current.status === "error"
        ? language.t("prompt.voice.failed")
        : language.t("prompt.voice.downloading")
  const label = () => {
    if (notReady()) return language.t("prompt.voice.turnOn")
    if (voice.state() === "listening") return language.t("prompt.voice.stop")
    if (voice.state() === "starting") return language.t("prompt.voice.starting")
    return language.t("prompt.voice.start")
  }

  return (
    <TooltipV2 placement="top" value={label()}>
      <Show
        when={voice.state() === "listening"}
        fallback={
          <IconButtonV2
            data-action="prompt-voice"
            data-state-voice={notReady() ? "off" : voice.state()}
            type="button"
            variant="ghost-muted"
            size="large"
            disabled={props.disabled || voice.state() !== "idle"}
            aria-label={label()}
            aria-busy={voice.state() !== "idle"}
            icon={voice.state() === "idle" ? <Icon name="microphone" /> : <LoaderV2 />}
            {...guard}
            onClick={(event: MouseEvent) => {
              event.preventDefault()
              const current = notReady()
              if (!current) return voice.toggle()
              showDictationHint(explain(current))
              settings()
            }}
          />
        }
      >
        <button
          data-action="prompt-voice"
          data-state-voice="listening"
          type="button"
          aria-label={label()}
          aria-pressed="true"
          class="flex h-7 max-w-[280px] items-center gap-1.5 rounded-md bg-v2-state-bg-danger px-2 text-[12px] font-[500] tabular-nums text-v2-state-fg-danger"
          {...guard}
          onClick={(event) => {
            event.preventDefault()
            voice.toggle()
          }}
        >
          <span class="size-2 shrink-0 animate-pulse rounded-full bg-current" />
          <span class="shrink-0">{formatVoiceDuration(voice.elapsed())}</span>
          <Show when={voice.state() === "ending"}>
            <LoaderV2 />
          </Show>
          <Icon name="stop-square" size="small" />
        </button>
      </Show>
    </TooltipV2>
  )
}