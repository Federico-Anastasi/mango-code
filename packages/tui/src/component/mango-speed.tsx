import { createSignal, onCleanup, onMount, Show } from "solid-js"

// mango-code: prefill and decode t/s of the local model, in the status bar.
//
// WHY IT IS PATCHED HERE AND IS NOT A PLUGIN. The clean way would be api.slots.register from an external
// TUI plugin, but in 1.18.23 the plugins declared in tui.json are never loaded (upstream #36525) and the
// files in plugin/ arrive only as server plugins, without `slots`. Verified on the official binary: tui.json
// is read ("applying tui config") and its `plugin` array ignored. Until it is fixed upstream, the bar can
// only be touched from inside.
//
// WHY TWO NUMBERS AND NOT ONE. With mismatched GPUs prefill and decode have different bottlenecks:
// prefill is compute (and on a card without tensor cores IT is the bottleneck), decode is memory bandwidth.
// A slow turn with low pp and high tg is "long context to digest"; high pp and low tg is "slow generation".
// They are two different knobs, and a single number confuses them.
//
// WHERE THEY COME FROM. llama-server exposes /metrics in Prometheus format. The cumulative COUNTERS are used
// and the difference between two readings is taken: the ready-made gauges (prompt_tokens_seconds,
// predicted_tokens_seconds) would be handier but llama.cpp RESETS the bucket at every scrape, so anyone else
// reading /metrics at the same moment takes the window away. The counters are monotonic: our delta stays right
// whatever the rest does.
//
// If /metrics does not answer the component renders NOTHING: on an opencode that is not mango-code the bar
// stays exactly as it was.

const ENDPOINT = process.env["MANGO_METRICS"] || "http://127.0.0.1:8080/metrics"
const EVERY_MS = 2000

const PROMPT_TOKENS = "llamacpp:prompt_tokens_total"
const PROMPT_SECONDS = "llamacpp:prompt_seconds_total"
const PRED_TOKENS = "llamacpp:tokens_predicted_total"
const PRED_SECONDS = "llamacpp:tokens_predicted_seconds_total"
const KEYS = [PROMPT_TOKENS, PROMPT_SECONDS, PRED_TOKENS, PRED_SECONDS]

type Sample = Record<string, number>

async function scrape(): Promise<Sample | undefined> {
  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return
    const out: Sample = {}
    for (const line of (await res.text()).split("\n")) {
      if (line.startsWith("#")) continue
      const sp = line.indexOf(" ")
      if (sp < 0) continue
      const name = line.slice(0, sp)
      if (!KEYS.includes(name)) continue
      const value = Number(line.slice(sp + 1).trim())
      if (Number.isFinite(value)) out[name] = value
    }
    return KEYS.every((k) => k in out) ? out : undefined
  } catch {
    return
  }
}

// 793.6 -> "794", 33.81 -> "33.8": below 100 t/s the decimal says something, above it is noise.
const rate = (tokens: number, seconds: number) => {
  const v = tokens / seconds
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1)
}

export function MangoSpeed(props: { muted: any; strong: any }) {
  const [prefill, setPrefill] = createSignal("")
  const [decode, setDecode] = createSignal("")

  onMount(() => {
    let previous: Sample | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    async function tick() {
      const now = await scrape()
      if (stopped) return
      if (now) {
        if (previous) {
          // Each half updates only if there was work of its own in this window: so the number of the last
          // turn stays on screen while the model is idle, instead of resetting to zero and making it look
          // like the engine is dead.
          const dPromptTok = now[PROMPT_TOKENS] - previous[PROMPT_TOKENS]
          const dPromptSec = now[PROMPT_SECONDS] - previous[PROMPT_SECONDS]
          if (dPromptTok > 0 && dPromptSec > 0.01) setPrefill(rate(dPromptTok, dPromptSec))

          const dPredTok = now[PRED_TOKENS] - previous[PRED_TOKENS]
          const dPredSec = now[PRED_SECONDS] - previous[PRED_SECONDS]
          if (dPredTok > 0 && dPredSec > 0.01) setDecode(rate(dPredTok, dPredSec))
        }
        previous = now
      }
      timer = setTimeout(tick, EVERY_MS)
    }

    tick()
    onCleanup(() => {
      stopped = true
      if (timer) clearTimeout(timer)
    })
  })

  return (
    <Show when={prefill() || decode()}>
      <text fg={props.strong}>
        <span style={{ fg: props.muted }}>pp </span>
        {prefill() || "-"}
        <span style={{ fg: props.muted }}> tg </span>
        {decode() || "-"}
        <span style={{ fg: props.muted }}> t/s</span>
      </text>
    </Show>
  )
}
