import { describe, expect, test } from "bun:test"
import { parseState } from "@/utils/mango-state"
import {
  arrivingRows,
  diskLabel,
  downloadLine,
  remoteEngine,
  removeLines,
  sizeTiers,
  styleTemperature,
  variantLine,
} from "./lines"

const where = { placement: "gpu", gpus: ["RTX 3060 Ti", "GTX 1080"], context: 131072 }
const state = (model: unknown) =>
  parseState({ revision: 4, catalog_revision: 2, model, default_model: "3.6", downloads: [] })

/** The words of the interface, with the keys in place of the sentences. */
const t = (key: string | number, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : `${key}`
const language = { t, intl: () => "en" } as never

describe("the lines of the models", () => {
  test("download and style", () => {
    const download = {
      model: "a",
      label: "A",
      state: "active" as const,
      done: 0,
      total: 600 * 1024 * 1024,
      bytes_per_second: 1024 * 1024,
      error: null,
      engine_only: false,
    }
    expect(downloadLine(download, language)).toContain('mango.eta.minutes {"count":10}')
    // while it comes, the line says the work goes on
    expect(downloadLine(download, language)).toEndWith(". settings.models.download.meanwhile")
    expect(downloadLine({ ...download, bytes_per_second: 0 }, language)).toEndWith(
      ". settings.models.download.meanwhile",
    )
    expect(downloadLine({ ...download, state: "paused" }, language)).not.toContain("meanwhile")
    expect(downloadLine({ ...download, state: "paused" }, language)).toContain("settings.models.download.paused")
    expect(downloadLine({ ...download, state: "failed", error: "Il disco è pieno." }, language)).toBe(
      "Il disco è pieno.",
    )
    // one that brings only the engine the app came with says so first
    expect(downloadLine({ ...download, engine_only: true }, language)).toStartWith("mango.engine.updating · ")
    expect(downloadLine({ ...download, state: "waiting", engine_only: true }, language)).toStartWith(
      "mango.engine.updating · ",
    )
    expect(styleTemperature("precise", { temperature: 0.1 })).toBe(0.1)
    expect(styleTemperature("precise", { temperature: 1 })).toBe(0.3)
    expect(styleTemperature("precise", null)).toBe(0.3)
    expect(styleTemperature("creative", { temperature: 0.1 })).toBe(1.1)
    expect(styleTemperature("recommended", { temperature: 0.7 })).toBe(0.7)
  })

  test("the engine of another PC with its models; none with this PC's engine", () => {
    expect(remoteEngine(state({ phase: "remote", address: "192.168.1.20:47098", models: ["Qwen", "Ling"] }))).toEqual({
      models: ["Qwen", "Ling"],
    })
    expect(remoteEngine(state({ phase: "ready", model: "3.6", label: "Qwen", where }))).toBeUndefined()
    expect(remoteEngine(undefined)).toBeUndefined()
  })

  test("the space of the models names the drive of their folder, or the folder where it has none", () => {
    const disk = { path: "c:\\Mango\\models", used_bytes: 41e9, free_bytes: 1 }
    expect(diskLabel(disk, t)).toContain('"drive":"C:"')
    expect(diskLabel({ ...disk, path: "/home/ada/models" }, t)).toContain('"drive":"/home/ada/models"')
  })

  test("the versions of a repo in thirds of weight; a single one keeps its name", () => {
    expect(sizeTiers([5, 1, 9])).toEqual(["medium", "small", "large"])
    expect(sizeTiers([1, 2, 3, 4, 5, 6])).toEqual(["small", "small", "medium", "medium", "large", "large"])
    expect(sizeTiers([7])).toBeUndefined()
  })

  test("a quantization says the context of the choice made: with images, the one with the encoder", () => {
    const fit = {
      bytes: 2 ** 30,
      placement: "gpu" as const,
      context: 40960,
      gpus: ["RTX 3060 Ti"],
      speed: null,
      reason: "",
      entry: {},
    }
    const variant = {
      ...fit,
      name: "Q4_K_M",
      key: "k",
      recommended: true,
      with_images: { ...fit, bytes: 2 ** 31, context: 32768, gpus: ["RTX 3060 Ti", "GTX 1080"] },
    }
    // how many cards, as the catalog's rows say it: the context of a larger one on two cards does not look random
    expect(variantLine(variant, false, true, language)).toEndWith(" · mango.where.cards.one · 40k")
    expect(variantLine(variant, true, true, language)).toEndWith(' · mango.where.cards.other {"count":2} · 32k')
    expect(variantLine(variant, true, false, language)).not.toContain("Q4_K_M")
    // with images it does not fit: no context
    const tight = { ...variant, with_images: { ...fit, placement: null, context: null } }
    expect(variantLine(tight, true, true, language)).toEndWith(" · settings.models.other.noFit")
    // on the processor: no cards, how fast it writes when it is known, and the context
    const cpu = { ...variant, placement: "cpu" as const, gpus: [], speed: "slow" as const }
    expect(variantLine(cpu, false, true, language)).toEndWith(
      " · settings.models.other.onCpu · settings.models.other.speed.slow · 40k",
    )
    expect(variantLine({ ...cpu, speed: null }, false, true, language)).toEndWith(
      " · settings.models.other.onCpu · 40k",
    )
  })

  test("«Togli» frees space for a downloaded model, and for a file of the user says it leaves the list and names the file", () => {
    const model = { label: "Ling", size: "4,5 GB", ownFiles: [] }
    expect(removeLines(model, t)).toEqual({
      action: 'settings.models.remove.action {"size":"4,5 GB"}',
      title: 'settings.models.remove.title {"name":"Ling"}',
      body: 'settings.models.remove.body {"size":"4,5 GB"}',
    })
    const mine = { ...model, label: "MiniCPM5", ownFiles: ["D:\\Modelli\\MiniCPM5-2B-Q4_K_M.gguf"] }
    expect(removeLines(mine, t)).toEqual({
      action: "settings.models.forget",
      title: 'settings.models.remove.listTitle {"name":"MiniCPM5"}',
      body: 'settings.models.remove.ownFile {"files":"MiniCPM5-2B-Q4_K_M.gguf"}',
    })
    const two = { ...mine, ownFiles: ["D:\\M\\a.gguf", "D:\\M\\mmproj.gguf"] }
    expect(removeLines(two, t).body).toBe('settings.models.remove.ownFiles {"files":"a.gguf, mmproj.gguf"}')
    // a model in many pieces: the first by name, and how many others
    const pieces = { ...mine, ownFiles: [1, 2, 3, 4, 5].map((n) => `D:\\M\\big-0000${n}-of-00005.gguf`) }
    expect(removeLines(pieces, t).body).toBe(
      'settings.models.remove.ownFilesMany {"file":"big-00001-of-00005.gguf","count":4}',
    )
  })

  test("«In arrivo» has one row for the engine, however many engines come", () => {
    const row = (model: string, engine_only: boolean) => ({
      model,
      label: model,
      state: "waiting" as const,
      done: 0,
      total: 1,
      bytes_per_second: 0,
      error: null,
      engine_only,
    })
    const list = [row("a", false), row("b", true), row("c", true), row("d", false)]
    expect(arrivingRows(list).map((download) => download.model)).toEqual(["a", "b", "d"])
    expect(arrivingRows([row("a", false)]).map((download) => download.model)).toEqual(["a"])
  })
})
