import { describe, expect, test } from "bun:test"
import { parseState } from "@/utils/mango-state"
import {
  arrivingRows,
  contextIssue,
  diskLabel,
  downloadLine,
  parseContext,
  parseSamplingValue,
  remoteEngine,
  removeLines,
  samplingIssue,
  samplingText,
  sizeTiers,
  stepContext,
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
  })

  test("a context typed: tokens, with or without separators, or a number of K (1024 tokens); nothing else", () => {
    expect(parseContext("100000")).toBe(100000)
    expect(parseContext(" 100.000 ")).toBe(100000)
    expect(parseContext("100,000")).toBe(100000)
    expect(parseContext("100 000")).toBe(100000)
    expect(parseContext("96k")).toBe(98304)
    expect(parseContext("96 K")).toBe(98304)
    for (const text of ["", "k", "-5", "1.5k", "abc", "12e3", "100000 tokens"]) expect(parseContext(text)).toBeUndefined()
  })

  test("the plus and the minus go in steps of 4096 tokens, from a number between two steps to the next one, within the limits", () => {
    expect(stepContext(65536, 1, 32768, 262144)).toBe(69632)
    expect(stepContext(65536, -1, 32768, 262144)).toBe(61440)
    expect(stepContext(100000, 1, 32768, 262144)).toBe(102400)
    expect(stepContext(100000, -1, 32768, 262144)).toBe(98304)
    expect(stepContext(32768, -1, 32768, 262144)).toBe(32768)
    expect(stepContext(262144, 1, 32768, 262144)).toBe(262144)
    expect(stepContext(90112, 1, 32768, 92160)).toBe(92160)
    // a choice left over from a larger computer comes back to the largest
    expect(stepContext(300000, -1, 32768, 262144)).toBe(262144)
  })

  test("a context under the minimum or over the maximum is told which, within them nothing", () => {
    expect(contextIssue(32767, 32768, 262144)).toBe("min")
    expect(contextIssue(262145, 32768, 262144)).toBe("max")
    expect(contextIssue(32768, 32768, 262144)).toBeUndefined()
    expect(contextIssue(262144, 32768, 262144)).toBeUndefined()
  })

  test("a value of the style is written as it is, so that leaving the box unchanged keeps it: no grouping, no rounding", () => {
    expect(samplingText(1000, "it")).toBe("1000")
    expect(samplingText(0.123456, "it")).toBe("0,123456")
    expect(samplingText(1.05, "en")).toBe("1.05")
    expect(parseSamplingValue("top_k", samplingText(1000, "it"))).toBe(1000)
    expect(parseSamplingValue("min_p", samplingText(0.123456, "it"))).toBe(0.123456)
  })

  test("the values of the style: a number with a point or a comma, whole for top_k, inside the interval of each", () => {
    expect(parseSamplingValue("temperature", "0,3")).toBe(0.3)
    expect(parseSamplingValue("temperature", " 1.05 ")).toBe(1.05)
    expect(parseSamplingValue("presence_penalty", "-1,5")).toBe(-1.5)
    expect(parseSamplingValue("top_k", "20")).toBe(20)
    for (const [name, text] of [
      ["top_k", "20.5"],
      ["top_k", "-1"],
      ["temperature", "abc"],
      ["temperature", ""],
      ["temperature", "1,"],
    ] as const)
      expect(parseSamplingValue(name, text)).toBeUndefined()
    // top_k is a 32-bit whole number in the app: a bigger one is outside its interval, not an error of the bridge
    expect(samplingIssue("top_k", 4_294_967_295)).toBe(false)
    expect(samplingIssue("top_k", 5_000_000_000)).toBe(true)
    expect(samplingIssue("temperature", 2)).toBe(false)
    expect(samplingIssue("temperature", 2.01)).toBe(true)
    expect(samplingIssue("temperature", -0.1)).toBe(true)
    expect(samplingIssue("top_p", 1)).toBe(false)
    expect(samplingIssue("top_p", 1.1)).toBe(true)
    expect(samplingIssue("min_p", 0)).toBe(false)
    expect(samplingIssue("presence_penalty", -2)).toBe(false)
    expect(samplingIssue("presence_penalty", 2.5)).toBe(true)
    expect(samplingIssue("repeat_penalty", 0)).toBe(true)
    expect(samplingIssue("repeat_penalty", 0.01)).toBe(false)
    expect(samplingIssue("top_k", 0)).toBe(false)
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
    expect(variantLine(variant, false, true, language)).toEndWith(" · mango.where.cards.one · 40K")
    expect(variantLine(variant, true, true, language)).toEndWith(' · mango.where.cards.other {"count":2} · 32K')
    expect(variantLine(variant, true, false, language)).not.toContain("Q4_K_M")
    // with images it does not fit: no context
    const tight = { ...variant, with_images: { ...fit, placement: null, context: null } }
    expect(variantLine(tight, true, true, language)).toEndWith(" · settings.models.other.noFit")
    // on the processor: no cards, how fast it writes when it is known, and the context
    const cpu = { ...variant, placement: "cpu" as const, gpus: [], speed: "slow" as const }
    expect(variantLine(cpu, false, true, language)).toEndWith(
      " · settings.models.other.onCpu · settings.models.other.speed.slow · 40K",
    )
    expect(variantLine({ ...cpu, speed: null }, false, true, language)).toEndWith(
      " · settings.models.other.onCpu · 40K",
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
