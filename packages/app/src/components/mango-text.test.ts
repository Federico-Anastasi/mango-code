import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { parseState } from "@/utils/mango-state"
import { arrivingParts, barDownload, barParts, composerParts, modelTag } from "./mango-model-bar"
import { downloadParts, etaText, fitsText, onWhere, queueText, readingText, statusLine } from "./mango-text"

// The English sentences of the app, filled like the interface fills them.
const t = ((key: string, params?: Record<string, string | number>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    (en as Record<string, string>)[key] ?? key,
  )) as never
const language = { t, intl: () => "en" } as never

const where = { placement: "gpu", gpus: ["RTX 3060 Ti", "GTX 1080"], context: 131072 }
const state = (model: unknown, downloads: unknown[] = []) =>
  parseState({ revision: 1, catalog_revision: 1, model, default_model: "3.6", downloads })!
const line = (
  s: ReturnType<typeof state>,
  extra: {
    downloaded?: string[]
    justReady?: boolean
    reading?: { doneTokens: number; totalTokens: number; ms: number }
    empty?: boolean
  } = {},
) =>
  statusLine(
    {
      state: s,
      downloaded: new Set(extra.downloaded ?? []),
      justReady: extra.justReady ?? false,
      reading: extra.reading,
      empty: extra.empty,
    },
    language,
  )
const GB = 1024 ** 3

describe("the line above the composer", () => {
  test("a load says the model, the cards, the context and the seconds; after a download, «Downloaded.»", () => {
    const loading = state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 20, where })
    expect(line(loading)).toEqual({ kind: "text", text: "Loading Qwen · RTX 3060 Ti + GTX 1080 · 128k · 20 s" })
    expect(line(loading, { downloaded: ["3.6"] })?.text).toBe(
      "Downloaded. Loading Qwen · RTX 3060 Ti + GTX 1080 · 128k · 20 s",
    )
    // before the plan is made it says only what it knows
    expect(line(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 1, where: null }))?.text).toBe(
      "Loading Qwen · 1 s",
    )
  })

  test("the first model's download: bytes and how long still, without the speed, and how far for the bar", () => {
    const active = {
      model: "3.6",
      label: "Qwen",
      state: "active",
      done: 0.5 * GB,
      total: 18 * GB,
      bytes_per_second: 24 * 1024 ** 2,
      error: null,
    }
    expect(line(state({ phase: "none" }, [active]))).toEqual({
      kind: "text",
      text: "Downloading Qwen · 512 MB of 18 GB · about 13 minutes",
      progress: 2,
    })
    expect(line(state({ phase: "none" }, [{ ...active, state: "failed", error: "No network." }]))?.text).toBe(
      "The download of Qwen did not succeed: No network.",
    )
    // without its sentence it does not end with a colon
    expect(line(state({ phase: "none" }, [{ ...active, state: "failed", error: "" }]))?.text).toBe(
      "The download of Qwen did not succeed.",
    )
    expect(line(state({ phase: "none" }))).toBeUndefined()
    // the Home's card says the speed too
    expect(downloadParts(state({ phase: "none" }, [active]).downloads[0], language)).toEqual({
      amount: "512 MB of 18 GB",
      speed: "24 MB per second",
      eta: "about 13 minutes",
    })
  })

  test("the models chosen together: the Home says which comes next, or how many", () => {
    const one = (model: string, label: string, st: string) => ({
      model,
      label,
      state: st,
      done: 0,
      total: 100,
      bytes_per_second: 0,
      error: null,
    })
    const first = state({ phase: "none" }, [one("ling", "Ling", "active"), one("4b", "Qwen 4B", "waiting")])
    expect(queueText(first, first.downloads[0], language)).toBe("Qwen 4B comes next.")
    const three = state({ phase: "none" }, [
      one("ling", "Ling", "active"),
      one("4b", "Qwen 4B", "waiting"),
      one("2b", "Qwen 2B", "waiting"),
      // one in pause does not come by itself
      one("3.6", "Qwen", "paused"),
    ])
    expect(queueText(three, three.downloads[0], language)).toBe("2 more models come next.")
    const alone = state({ phase: "none" }, [one("ling", "Ling", "active")])
    expect(queueText(alone, alone.downloads[0], language)).toBeUndefined()
  })

  test("a wait: «about» only before a number, no «0 min»", () => {
    expect(etaText(20, language)).toBe("less than a minute")
    expect(etaText(60, language)).toBe("about 1 minute")
    expect(etaText(7200, language)).toBe("about 2 h")
    expect(etaText(7200 + 300, language)).toBe("about 2 h 5 min")
  })

  test("where a model loads or fits", () => {
    const one = { placement: "gpu" as const, gpus: ["RTX 3060 Ti"], context: 65536 }
    const two = { placement: "gpu" as const, gpus: ["RTX 3060 Ti", "GTX 1080"], context: 65536 }
    const cpu = { placement: "cpu" as const, gpus: [], context: 32768 }
    expect(fitsText(one, language)).toBe("It fits on the RTX 3060 Ti alone.")
    expect(fitsText(two, language)).toBe("It fits on the cards RTX 3060 Ti + GTX 1080.")
    expect(fitsText(cpu, language)).toBe("It fits on the processor.")
    expect(onWhere(one, language)).toBe("on the RTX 3060 Ti")
    expect(onWhere(cpu, language)).toBe("on the processor")
  })

  test("the other PC's engine that does not answer says why the messages wait", () => {
    expect(line(state({ phase: "remote", address: "192.168.1.5:47098", models: [], reachable: false }))?.text).toBe(
      "The other PC's engine does not answer: the messages leave when it does.",
    )
    expect(line(state({ phase: "remote", address: "192.168.1.5:47098", models: [] }))).toBeUndefined()
  })

  test("a failed start says why and offers the model that fits now", () => {
    const proposal = {
      model: "ling",
      label: "Ling",
      where: { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 65536 },
    }
    expect(
      line(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "Another program uses 5 GB.", proposal })),
    ).toMatchObject({
      kind: "failed",
      text: "Qwen does not start: Another program uses 5 GB.",
      proposal: { model: "ling", label: "Ling", where: { gpus: ["RTX 3060 Ti"], context: 65536 } },
    })
    expect(line(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No." }))).toMatchObject({
      proposal: null,
    })
    // another program on the card: its sentence; no reason at all: nothing after «does not start»
    expect(
      line(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "CUDA error", taken: "Close it." }))?.text,
    ).toBe("Qwen does not start: Close it.")
    expect(line(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "" }))?.text).toBe("Qwen does not start.")
  })

  test("a model just ready says where it runs and how much it remembers; then the line goes away", () => {
    const ready = state({ phase: "ready", model: "3.6", label: "Qwen", where })
    expect(line(ready, { justReady: true })).toEqual({
      kind: "ready",
      text: "Qwen is ready: it runs on 2 cards and remembers about 85 thousand words.",
    })
    expect(line(ready)).toBeUndefined()
    const cpu = state({
      phase: "ready",
      model: "ling",
      label: "Ling",
      where: { placement: "cpu", gpus: [], context: 32768 },
    })
    expect(line(cpu, { justReady: true })?.text).toBe(
      "Ling is ready: it runs on the processor and remembers about 21 thousand words.",
    )
  })

  test("the engine the app came with, for the models on the disk: «Updating the engine», never the first model's download", () => {
    const engine = {
      model: "3.6",
      label: "Qwen",
      state: "active",
      done: 100 * 1024 ** 2,
      total: 400 * 1024 ** 2,
      bytes_per_second: 0,
      error: null,
      engine_only: true,
    }
    expect(line(state({ phase: "none" }, [engine]))).toEqual({
      kind: "text",
      text: "Updating the engine · 100 MB of 400 MB",
      progress: 25,
    })
    expect(line(state({ phase: "none" }, [{ ...engine, state: "paused" }]))?.text).toBe("The engine update is paused")
    expect(line(state({ phase: "none" }, [{ ...engine, state: "failed", error: "No network." }]))?.text).toBe(
      "The engine update did not succeed: No network.",
    )
    expect(barParts(state({ phase: "none" }, [engine]), t)).toEqual({ name: "Updating the engine", status: "25%" })
  })

  test("the engine working on the conversation says for how long: no tokens", () => {
    const ready = state({ phase: "ready", model: "3.6", label: "Qwen", where })
    expect(line(ready, { reading: { doneTokens: 1200, totalTokens: 24000, ms: 2400 } })?.text).toBe(
      "Preparing the conversation · 2 s",
    )
    expect(line(ready, { reading: { doneTokens: 0, totalTokens: 24000, ms: 100 } })?.text).toBe(
      "Preparing the conversation · 1 s",
    )
    // the row in the conversation says the same
    expect(readingText({ doneTokens: 1200, totalTokens: 24000, ms: 2400 }, language)).toBe(
      "Preparing the conversation · 2 s",
    )
  })

  test("the cards lent to another program", () => {
    expect(line(state({ phase: "lent", model: "3.6", label: "Qwen" }))?.text).toBe(
      "The graphics cards are lent to another program: Qwen starts again when they come back.",
    )
  })
})

describe("the model in the top bar", () => {
  test("its name, and what it is doing while it is not simply ready, apart: the name gives way first", () => {
    expect(barParts(state({ phase: "ready", model: "3.6", label: "Qwen", where }), t)).toEqual({ name: "Qwen" })
    expect(barParts(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 12 }), t)).toEqual({
      name: "Qwen",
      status: "loading, 12 s",
    })
    expect(barParts(state({ phase: "lent", model: "3.6", label: "Qwen" }), t)).toEqual({
      name: "Qwen",
      status: "cards lent",
    })
    // a start that failed: no model in use
    expect(barParts(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "" }), t)).toEqual({
      name: "No model in use",
    })
    expect(
      barParts(
        state({ phase: "none" }, [
          { model: "3.6", label: "Qwen", state: "active", done: 3, total: 100, bytes_per_second: 1 },
        ]),
        t,
      ),
    ).toEqual({ name: "Qwen", status: "downloading 3%" })
    // a download that stopped is not «downloading»
    expect(
      barParts(
        state({ phase: "none" }, [
          { model: "3.6", label: "Qwen", state: "failed", done: 3, total: 100, bytes_per_second: 0 },
        ]),
        t,
      ),
    ).toEqual({ name: "No model in use" })
    expect(barParts(state({ phase: "none" }), t)).toEqual({ name: "No model in use" })
  })

  test("under the composer the same words as the bar, the load without its seconds", () => {
    const download = { model: "ling", label: "Ling", state: "active", done: 7, total: 100, bytes_per_second: 1 }
    // no model on the computer: the model coming, never one of the catalog the agent would pick
    expect(composerParts(state({ phase: "none" }, [download]), t)).toEqual({ name: "Ling", status: "downloading 7%" })
    expect(composerParts(state({ phase: "loading", model: "ling", label: "Ling", seconds: 3 }), t)).toEqual({
      name: "Ling",
      status: "loading",
    })
    expect(composerParts(state({ phase: "ready", model: "ling", label: "Ling", where }), t)).toEqual({ name: "Ling" })
    expect(composerParts(state({ phase: "none" }), t)).toEqual({ name: "No model in use" })
  })

  test("the label of a download leads to its row: only while it names one", () => {
    const active = { model: "3.6", label: "Qwen", state: "active", done: 3, total: 100, bytes_per_second: 1 }
    expect(barDownload(state({ phase: "none" }, [active]))?.model).toBe("3.6")
    expect(barDownload(state({ phase: "none" }, [{ ...active, state: "paused" }]))).toBeUndefined()
    expect(barDownload(state({ phase: "ready", model: "ling", label: "Ling", where }, [active]))).toBeUndefined()
  })

  test("the menu says which model is in use, which is the default, which is loading", () => {
    const loading = state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 2 })
    expect(modelTag("3.6", loading, t)).toBe("Default · loading")
    expect(modelTag("ling", state({ phase: "ready", model: "ling", label: "Ling", where }), t)).toBe("In use")
    expect(modelTag("4b", loading, t)).toBeUndefined()
  })

  test("under the models the menu lists the downloads on their way: how far, waiting, paused, failed", () => {
    const coming = {
      model: "3.6",
      label: "Qwen",
      state: "active",
      done: 42,
      total: 100,
      bytes_per_second: 1,
      error: null,
    }
    const row = (extra: Record<string, unknown>) =>
      arrivingParts(
        state({ phase: "ready", model: "ling", label: "Ling", where }, [{ ...coming, ...extra }]).downloads[0],
        t,
      )
    expect(row({})).toEqual({ name: "Arriving: Qwen", status: "42%" })
    expect(row({ state: "waiting" })).toEqual({ name: "Arriving: Qwen", status: "waiting" })
    expect(row({ state: "paused" })).toEqual({ name: "Arriving: Qwen", status: "paused" })
    expect(row({ state: "failed", error: "No." })).toEqual({ name: "Arriving: Qwen", status: "failed" })
    expect(row({ engine_only: true })).toEqual({ name: "Updating the engine", status: "42%" })
  })
})

describe("no model on the computer", () => {
  test("the line says it and leads to Models; with a download that stopped, its sentence", () => {
    expect(line(state({ phase: "none" }), { empty: true })).toEqual({
      kind: "empty",
      text: "There is no model on this computer: writing needs one.",
    })
    const paused = {
      model: "3.6",
      label: "Qwen",
      state: "paused",
      done: 5,
      total: 10,
      bytes_per_second: 0,
      error: null,
    }
    expect(line(state({ phase: "none" }, [paused]), { empty: true })?.kind).toBe("empty")
    expect(line(state({ phase: "none" }, [paused]))?.kind).toBe("text")
    // models on the disk and none in use: nothing to say
    expect(line(state({ phase: "none" }))).toBeUndefined()
  })
})
