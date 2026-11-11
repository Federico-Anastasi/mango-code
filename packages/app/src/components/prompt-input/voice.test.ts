import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createVoiceDictation, type VoiceEvent } from "./voice"
import type { VoiceFailure } from "./dictation"

// The browser side of the microphone, as little as the dictation touches it: a stream with no tracks and an audio
// context whose processor hands the test the callback to feed audio by hand.
let feed: (() => void) | undefined
class FakeAudioContext {
  destination = {}
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  createScriptProcessor() {
    const processor = {
      connect() {},
      disconnect() {},
      onaudioprocess: undefined as ((event: unknown) => void) | undefined,
    }
    feed = () => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.5) } })
    return processor
  }
  async close() {}
}

const original = { audio: globalThis.AudioContext, devices: navigator.mediaDevices }
beforeEach(() => {
  globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [] }) },
  })
})
afterEach(() => {
  globalThis.AudioContext = original.audio
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: original.devices })
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function dictation(input: {
  start?: () => Promise<string>
  pcm?: (id: string, audio: ArrayBuffer) => Promise<VoiceEvent[]>
  end?: (id: string) => Promise<VoiceEvent[]>
}) {
  const errors: VoiceFailure[] = []
  let dispose = () => {}
  const voice = createRoot((d) => {
    dispose = d
    return createVoiceDictation({
      start: input.start ?? (async () => "id"),
      pcm: input.pcm ?? (async () => []),
      end: input.end ?? (async () => []),
      onText: () => {},
      onPartial: () => {},
      onClear: () => {},
      onError: (failure) => errors.push(failure),
    })
  })
  return { voice, errors, dispose }
}

describe("createVoiceDictation", () => {
  test("closing the page while the service is still starting closes the session that starts afterwards", async () => {
    const ended: string[] = []
    let started!: (id: string) => void
    const { voice, dispose } = dictation({
      start: () => new Promise((resolve) => (started = resolve)),
      end: async (id) => {
        ended.push(id)
        return []
      },
    })
    voice.toggle()
    await wait(0)
    expect(voice.state()).toBe("starting")
    dispose()
    started("late")
    await wait(10)
    expect(ended).toEqual(["late"])
    expect(feed).toBeUndefined()
  })

  test("audio that could not be sent goes out with the next request, and the failure is reported once", async () => {
    const sent: number[] = []
    let online = false
    const { voice, errors, dispose } = dictation({
      pcm: async (_id, audio) => {
        if (!online) throw new Error("offline")
        sent.push(audio.byteLength)
        return []
      },
    })
    voice.toggle()
    await wait(10)
    feed!()
    await wait(1000)
    // two requests failed (every 450 ms), one report
    expect(errors).toEqual([{ kind: "service" }])
    expect(sent).toEqual([])
    online = true
    await wait(600)
    // the 8 KiB of the one piece fed (4096 samples, 16 bits) arrived
    expect(sent).toEqual([8192])
    expect(errors).toHaveLength(1)
    dispose()
  })
})
