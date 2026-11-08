// mango-code: the pure part of dictation (see voice.tsx), testable without a browser.
export type VoiceFailureKind =
  | "unsupported"
  | "no-device"
  | "denied"
  | "busy"
  | "service"
  | "empty"
  | "limit"
  | "timeout"

/** A recording longer than this stops by itself and what was said up to that point is transcribed. */
export const VOICE_MAX_RECORDING_SECONDS = 5 * 60
/** Maximum wait for the transcription: beyond it, the page stops waiting (the server waits up to 11 minutes). */
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 4 * 60_000
export type VoiceFailure = { kind: VoiceFailureKind; detail?: string }

export function voiceFailureFromMediaError(error: unknown): VoiceFailure {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ""
  if (name === "NotFoundError" || name === "OverconstrainedError") return { kind: "no-device" }
  if (name === "NotAllowedError" || name === "SecurityError") return { kind: "denied" }
  if (name === "NotReadableError" || name === "AbortError") return { kind: "busy" }
  return { kind: "unsupported", detail: error instanceof Error ? error.message : String(error) }
}

export function formatVoiceDuration(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

type DictationPart = { type: string; content?: string; start?: number; end?: number }

// Appends the dictated text to the text parts of the prompt (images stay at the end, as the editor keeps
// them), with a separating space if needed.
export function appendDictation<T extends DictationPart>(parts: readonly T[], text: string) {
  const content = parts.filter((part) => part.type !== "image")
  const images = parts.filter((part) => part.type === "image")
  const value = content.map((part) => part.content ?? "").join("")
  const clean = text.trim()
  const addition = value.length > 0 && !/\s$/.test(value) ? ` ${clean}` : clean
  const end = value.length
  const last = content.at(-1)
  const next =
    last?.type === "text"
      ? [...content.slice(0, -1), { ...last, content: (last.content ?? "") + addition, end: end + addition.length }]
      : [...content, { type: "text", content: addition, start: end, end: end + addition.length } as unknown as T]
  return { parts: [...next, ...images], value: value + addition, cursor: end + addition.length }
}
