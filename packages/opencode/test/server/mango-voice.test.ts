import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Server } from "../../src/server/server"
import { VOICE_TRANSCRIBE_PATH } from "../../src/server/shared/voice"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// mango-code: the dictation route forwards the audio to the local service announced in
// MANGO_VOICE_URL and returns its response.
const original = process.env.MANGO_VOICE_URL
const originalSettings = process.env.MANGO_SETTINGS

// The error texts follow the chosen language: the tests fix it to Italian.
beforeAll(() => {
  const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mango-voice-")), "settings.json")
  fs.writeFileSync(settings, JSON.stringify({ language: "it" }))
  process.env.MANGO_SETTINGS = settings
})

afterAll(() => {
  if (originalSettings === undefined) delete process.env.MANGO_SETTINGS
  else process.env.MANGO_SETTINGS = originalSettings
})

afterEach(async () => {
  if (original === undefined) delete process.env.MANGO_VOICE_URL
  else process.env.MANGO_VOICE_URL = original
  await disposeAllInstances()
  await resetDatabase()
})

function post(body: BodyInit) {
  return Server.Default().app.request(VOICE_TRANSCRIBE_PATH, {
    method: "POST",
    headers: { "content-type": "audio/webm;codecs=opus" },
    body,
  })
}

describe("dictation", () => {
  test("without a running service answers 503 with the reason", async () => {
    delete process.env.MANGO_VOICE_URL
    const response = await post(new Uint8Array([1, 2, 3]))
    expect(response.status).toBe(503)
    expect((await response.json()).error).toContain("dettatura spenta")
  })

  test("forwards audio and type to the service and returns its response", async () => {
    const seen: { path?: string; type?: string | null; size?: number } = {}
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen.path = new URL(request.url).pathname
        seen.type = request.headers.get("content-type")
        seen.size = (await request.arrayBuffer()).byteLength
        return Response.json({ text: "hello", audio_s: 1, elapsed_s: 0.1 })
      },
    })
    try {
      process.env.MANGO_VOICE_URL = `http://127.0.0.1:${upstream.port}`
      const response = await post(new Uint8Array(1000))
      expect(response.status).toBe(200)
      expect((await response.json()).text).toBe("hello")
      expect(seen).toEqual({ path: "/transcribe", type: "audio/webm;codecs=opus", size: 1000 })
    } finally {
      upstream.stop(true)
    }
  })

  test("unreachable service: 502", async () => {
    process.env.MANGO_VOICE_URL = "http://127.0.0.1:9"
    const response = await post(new Uint8Array([1]))
    expect(response.status).toBe(502)
  })
})
