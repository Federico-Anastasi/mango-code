import { describe, expect, test } from "bun:test"
import {
  becameReady,
  canSend,
  chosenBytes,
  contextLabel,
  diskDrive,
  conversationModel,
  etaParts,
  firstRun,
  homeView,
  messageWaits,
  missingParent,
  newer,
  noModel,
  offered,
  parseCatalog,
  parseComputer,
  parseImageModels,
  parseState,
  pollDelay,
  recommended,
  type MangoState,
} from "./mango-state"

const where = { placement: "gpu", gpus: ["RTX 3060 Ti", "GTX 1080"], context: 131072 }
const state = (model: unknown, downloads: unknown[] = [], conversation_model: string | null = null) =>
  parseState({ revision: 3, catalog_revision: 1, model, default_model: "3.6", downloads, conversation_model })!
const download = (state: string) => ({
  model: "3.6",
  label: "Qwen",
  state,
  done: 5,
  total: 10,
  bytes_per_second: 1,
  error: null,
})
const entry = (key: string, present: boolean, fits: boolean, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  present,
  bytes: 100,
  verdict: { fits, where: fits ? where : null, reason: fits ? "" : "Non ci sta.", speed: null, fastest: false },
  choices: { where: "auto", gpus: [], context: null, style: "recommended", reasoning: null, sampling: {} },
  limits: { where: ["auto", "one", "cpu"], context: [32768, 65536, 131072], reasoning: ["off", "on"] },
  ...extra,
})

describe("the app's state, as the agent tells it", () => {
  test("a catalog keeps the entries that read and drops the others; sampling keeps only its known values", () => {
    const catalog = parseCatalog({
      models: [
        entry("ling", true, true, { sampling: { temperature: 1, top_k: 20, unknown: 3 }, user: true }),
        entry("bad", true, true, { choices: { where: "moon" } }),
        entry("nolimits", true, true, { limits: null }),
        { key: 3 },
      ],
    })!
    expect(catalog.map((model) => model.key)).toEqual(["ling"])
    expect(catalog[0].sampling).toEqual({ temperature: 1, top_k: 20 })
    expect(catalog[0].user).toBe(true)
    expect(catalog[0].limits).toEqual({
      where: ["auto", "one", "cpu"],
      context: [32768, 65536, 131072],
      reasoning: ["off", "on"],
    })
    expect(parseCatalog({ models: [entry("a", true, true)] })![0].sampling).toBeNull()
    expect(parseCatalog({ models: [] })).toEqual([])
    // a model that waits for the new engine says so; one that does not say it does not wait
    const waiting = parseCatalog({
      models: [entry("w", false, true, { waits_engine: true }), entry("a", false, true)],
    })!
    expect(waiting.map((model) => model.waitsEngine)).toEqual([true, false])
    // the files the user chose, which «Togli» leaves; none for a model whose files Mango Code downloads
    const own = parseCatalog({
      models: [entry("mine", true, true, { user: true, own_files: ["D:\\m.gguf"] }), entry("a", true, true)],
    })!
    expect(own.map((model) => model.ownFiles)).toEqual([["D:\\m.gguf"], []])
    // the folder of the files the user moved out of the models folder; none for a model that is in it
    const placed = parseCatalog({
      models: [entry("moved", true, true, { placed_in: "D:\\Fast" }), entry("a", true, true)],
    })!
    expect(placed.map((model) => model.placedIn)).toEqual(["D:\\Fast", undefined])
  })

  test("the values chosen for a model's style are read with their known names; a model whose choices have none does not read", () => {
    const choices = { where: "auto" as const, gpus: [], context: 100000, style: "precise" as const, reasoning: null }
    const [model] = parseCatalog({
      models: [entry("a", true, true, { choices: { ...choices, sampling: { temperature: 0.4, top_k: 10, junk: 1, top_p: "x" } } })],
    })!
    expect(model.choices).toEqual({ ...choices, sampling: { temperature: 0.4, top_k: 10 } })
    expect(parseCatalog({ models: [entry("a", true, true, { choices })] })).toBeUndefined()
    expect(parseCatalog({ models: [entry("a", true, true, { choices: { ...choices, sampling: 3 } })] })).toBeUndefined()
  })

  test("a catalog whose models are all left out, or no list at all, does not read: it is not a computer without models", () => {
    expect(parseCatalog({ models: [entry("bad", true, true, { choices: null }), { key: 3 }] })).toBeUndefined()
    expect(parseCatalog({})).toBeUndefined()
    expect(parseCatalog(null)).toBeUndefined()
  })

  test("a computer reads with its cards; a card without a name is left out", () => {
    const pc = parseComputer({
      gpus: [{ name: "RTX 3060 Ti", memory_mib: 8192, used: true, note: "La più potente." }, { name: 3 }],
      small_models: "all",
      cpu: "Intel Core i7",
      cores: 8,
      ram_mib: 40960,
      disk: { path: "C:\\Mango\\models", used_bytes: 41e9, free_bytes: 200e9 },
      engine: { label: "llama.cpp", installed: true },
      tailored: { models: 5 },
    })
    expect(pc?.gpus).toEqual([{ name: "RTX 3060 Ti", memory_mib: 8192, used: true, note: "La più potente." }])
    expect(pc?.small_models).toBe("all")
    expect(pc?.disk.used_bytes).toBe(41e9)
    expect(pc?.engine).toEqual({ label: "llama.cpp", installed: true, update: false })
    expect(pc?.tailored).toEqual({ models: 5 })
    expect(parseComputer(null)).toBeUndefined()
  })

  test("a computer without its processor, memory, disk or engine does not read", () => {
    const whole = {
      gpus: [],
      cpu: "Intel Core i7",
      cores: 8,
      ram_mib: 40960,
      disk: { path: "C:\\Mango\\models", used_bytes: 1, free_bytes: 2 },
      engine: { label: "llama.cpp", installed: true, update: true },
    }
    expect(parseComputer(whole)?.engine.update).toBe(true)
    for (const key of ["cpu", "cores", "ram_mib", "disk", "engine"] as const)
      expect(parseComputer({ ...whole, [key]: undefined })).toBeUndefined()
  })

  test("a download says whether it brings only the engine", () => {
    expect(state({ phase: "none" }, [{ ...download("active"), engine_only: true }]).downloads[0].engine_only).toBe(true)
    expect(state({ phase: "none" }, [download("active")]).downloads[0].engine_only).toBe(false)
  })

  test("the model of the image engine that is on comes with the state; none while it is off", () => {
    const base = { revision: 3, catalog_revision: 1, model: { phase: "none" }, default_model: null, downloads: [] }
    expect(parseState({ ...base, image_loaded: "z-image-turbo" })?.image_loaded).toBe("z-image-turbo")
    expect(parseState({ ...base, image_loaded: null })?.image_loaded).toBeNull()
    expect(parseState(base)?.image_loaded).toBeNull()
  })

  test("the models that make pictures read with their line, license, weight and where they draw; one that does not read is left out", () => {
    const picture = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      label: key.toUpperCase(),
      about: "Una riga.",
      license: "Apache-2.0",
      present: false,
      bytes: 6_700_000_000,
      where: { placement: "gpu", gpus: ["RTX 3060 Ti"] },
      ...extra,
    })
    const read = parseImageModels({
      models: [],
      image_models: [
        picture("z"),
        picture("f", { license: null, about: undefined, present: true, where: { placement: "cpu", gpus: [] } }),
        picture("broken", { present: "yes" }),
        { label: "no key" },
      ],
      image_default: "z",
    })
    expect(read?.default).toBe("z")
    expect(read?.models).toEqual([
      {
        key: "z",
        label: "Z",
        about: "Una riga.",
        license: "Apache-2.0",
        present: false,
        bytes: 6_700_000_000,
        draws: { placement: "gpu", gpus: ["RTX 3060 Ti"] },
      },
      {
        key: "f",
        label: "F",
        about: "",
        license: null,
        present: true,
        bytes: 6_700_000_000,
        draws: { placement: "cpu", gpus: [] },
      },
    ])
    // an app without pictures says nothing of them: there is no group, which is not an empty one
    expect(parseImageModels({ models: [] })).toBeUndefined()
    expect(parseImageModels({ image_models: [] })).toEqual({ models: [], default: null })
    expect(parseImageModels(undefined)).toBeUndefined()
  })

  test("a ready model carries the line about it, or none", () => {
    const line = "I can't read the memory of the cards (GPU 0): I can't tell whether another program is using it."
    expect(state({ phase: "ready", model: "3.6", label: "Qwen", where, notice: line }).model).toMatchObject({ notice: line })
    expect(state({ phase: "ready", model: "3.6", label: "Qwen", where, notice: null }).model).toMatchObject({ notice: null })
    expect(state({ phase: "ready", model: "3.6", label: "Qwen", where }).model).toMatchObject({ notice: null })
  })

  test("the choices of reasoning are the names of a level, or none; the levels of a model leave out what is not one", () => {
    const choices = { where: "auto", gpus: [], context: null, style: "recommended", sampling: {} }
    const limits = { where: ["auto"], context: [32768] }
    const read = (reasoning: unknown, offered: unknown) =>
      parseCatalog({
        models: [entry("a", true, true, { choices: { ...choices, reasoning }, limits: { ...limits, reasoning: offered } })],
      })?.[0]
    expect(read("medium", ["low", "medium", "high"])).toMatchObject({
      choices: { reasoning: "medium" },
      limits: { reasoning: ["low", "medium", "high"] },
    })
    expect(read(null, ["off", "on", "maximum", 3])?.limits.reasoning).toEqual(["off", "on"])
    expect(read(null, [])?.limits.reasoning).toEqual([])
    expect(read(null, undefined)?.limits.reasoning).toEqual([])
    expect(read(true, ["off", "on"])).toBeUndefined()
    expect(read("maximum", ["off", "on"])).toBeUndefined()
  })

  test("a failed start carries the model that fits now, or none", () => {
    const proposal = {
      model: "ling",
      label: "Ling",
      where: { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 65536 },
    }
    expect(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No.", proposal }).model).toEqual({
      phase: "failed",
      model: "3.6",
      label: "Qwen",
      reason: "No.",
      taken: null,
      proposal: { model: "ling", label: "Ling", where: { placement: "gpu", gpus: ["RTX 3060 Ti"], context: 65536 } },
    })
    // which card another program holds comes apart from the manager's sentence
    expect(
      state({
        phase: "failed",
        model: "3.6",
        label: "Qwen",
        reason: "CUDA error",
        taken: "Another program takes 5 GB.",
      }).model,
    ).toMatchObject({
      reason: "CUDA error",
      taken: "Another program takes 5 GB.",
    })
    // no proposal yet: it is null, not an error
    expect(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No." }).model).toMatchObject({
      proposal: null,
    })
    expect(
      state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No.", proposal: { model: "x" } }).model,
    ).toMatchObject({
      proposal: null,
    })
  })

  test("what is not right is left out: a phase without its model is none, a broken body is no state", () => {
    expect(state({ phase: "ready", model: "3.6" }).model).toEqual({ phase: "none" })
    expect(state({ phase: "moon" }).model).toEqual({ phase: "none" })
    expect(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 4, where: null }).model).toMatchObject({
      seconds: 4,
      where: null,
    })
    expect(state({ phase: "none" }, [download("active"), download("dancing"), { model: 3 }]).downloads).toHaveLength(1)
    for (const nothing of [undefined, null, [], "x", { model: {} }]) expect(parseState(nothing)).toBeUndefined()
  })

  test("the engine of another PC answers unless it says otherwise", () => {
    expect(state({ phase: "remote", address: "192.168.1.5:47098", models: ["Qwen"] }).model).toEqual({
      phase: "remote",
      models: ["Qwen"],
      reachable: true,
    })
    expect(state({ phase: "remote", address: "192.168.1.5:47098", models: [], reachable: false }).model).toMatchObject({
      reachable: false,
    })
  })

  test("it is read every second while something changes, every five otherwise, every fifteen hidden or unanswered", () => {
    const shown = { hidden: false, failures: 0 }
    expect(pollDelay(undefined, shown)).toBe(5000)
    expect(pollDelay(state({ phase: "ready", model: "3.6", label: "Qwen", where }), shown)).toBe(5000)
    expect(pollDelay(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 1 }), shown)).toBe(1000)
    expect(pollDelay(state({ phase: "none" }, [download("active")]), shown)).toBe(1000)
    expect(pollDelay(state({ phase: "none" }, [download("waiting")]), shown)).toBe(1000)
    expect(pollDelay(state({ phase: "none" }, [download("paused")]), shown)).toBe(5000)
    expect(
      pollDelay(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 1 }), { hidden: true, failures: 0 }),
    ).toBe(15_000)
    expect(pollDelay(state({ phase: "none" }, [download("active")]), { hidden: false, failures: 1 })).toBe(15_000)
  })

  test("an answer older than the state shown does not replace it", () => {
    const at = (revision: number) =>
      parseState({ revision, catalog_revision: 1, model: { phase: "none" }, downloads: [] })!
    expect(newer(undefined, at(1))).toBe(true)
    expect(newer(at(5), at(5))).toBe(true)
    expect(newer(at(5), at(6))).toBe(true)
    expect(newer(at(5), at(4))).toBe(false)
  })

  test("a model just ready is one that was not ready in the state shown, its load seen or not", () => {
    const ready = state({ phase: "ready", model: "3.6", label: "Qwen", where })
    expect(becameReady(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 3 }), ready)).toBe(true)
    // the download ended and the load was over before the next read
    expect(becameReady(state({ phase: "none" }, [download("active")]), ready)).toBe(true)
    expect(becameReady(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "" }), ready)).toBe(true)
    expect(becameReady(state({ phase: "ready", model: "ling", label: "Ling", where }), ready)).toBe(true)
    // already ready, the first read, a state that is not ready
    expect(becameReady(ready, ready)).toBe(false)
    expect(becameReady(undefined, ready)).toBe(false)
    expect(becameReady(ready, state({ phase: "loading", model: "ling", label: "Ling", seconds: 0 }))).toBe(false)
  })

  test("the menus offer the models on the disk, or every one of the other PC's engine, and none before the catalog", () => {
    const ready = state({ phase: "ready", model: "3.6", label: "Qwen", where })
    const catalog = parseCatalog({ models: [entry("3.6", true, true), entry("ling", false, true)] })
    expect(["3.6", "ling", "mine"].filter((key) => offered(ready, catalog, key))).toEqual(["3.6", "mine"])
    expect(offered(ready, undefined, "3.6")).toBe(false)
    expect(offered(state({ phase: "remote", address: "a", models: [] }), undefined, "ling")).toBe(true)
  })

  test("the conversation's model follows the one the engine is on or going to", () => {
    expect(conversationModel(state({ phase: "loading", model: "ling", label: "Ling", seconds: 0 }))).toBe("ling")
    expect(conversationModel(state({ phase: "ready", model: "3.6", label: "Qwen", where }))).toBe("3.6")
    expect(conversationModel(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "" }))).toBeUndefined()
    expect(conversationModel(state({ phase: "none" }))).toBeUndefined()
  })

  test("with no model in use, the conversation's model is the one being downloaded, never the agent's own pick", () => {
    expect(conversationModel(state({ phase: "none" }, [download("active")]))).toBe("3.6")
    expect(conversationModel(state({ phase: "none" }, [download("waiting")]))).toBe("3.6")
    // a size not known yet: the bar does not name it, the engine still goes to it
    expect(conversationModel(state({ phase: "none" }, [{ ...download("active"), total: 0 }]))).toBe("3.6")
    expect(conversationModel(state({ phase: "none" }, [download("paused")]))).toBeUndefined()
    expect(conversationModel(state({ phase: "none" }, [download("failed")]))).toBeUndefined()
    expect(conversationModel(state({ phase: "none" }, [{ ...download("active"), engine_only: true }]))).toBeUndefined()
    expect(
      conversationModel(state({ phase: "failed", model: "ling", label: "Ling", reason: "" }, [download("active")])),
    ).toBeUndefined()
  })
})

describe("the model the conversations follow when the engine is on another for a side request", () => {
  test("the app says it with the state, none otherwise", () => {
    const base = { revision: 3, catalog_revision: 1, model: { phase: "none" }, default_model: null, downloads: [] }
    expect(parseState({ ...base, conversation_model: "3.6" })?.conversation_model).toBe("3.6")
    expect(parseState({ ...base, conversation_model: null })?.conversation_model).toBeNull()
    expect(parseState(base)?.conversation_model).toBeNull()
  })

  test("it is the model the conversations had, whatever the engine is on or loading", () => {
    const ling = { phase: "ready", model: "ling", label: "Ling", where }
    expect(conversationModel(state(ling, [], "3.6"))).toBe("3.6")
    expect(conversationModel(state({ phase: "loading", model: "ling", label: "Ling", seconds: 1 }, [], "3.6"))).toBe("3.6")
    expect(conversationModel(state({ phase: "lent", model: "ling", label: "Ling" }, [], "3.6"))).toBe("3.6")
    expect(conversationModel(state(ling))).toBe("ling")
  })
})

describe("a message sent before the model is ready", () => {
  test("waits while the model loads, the cards are lent, the start failed, or a download brings the first model", () => {
    const waits = (s: MangoState) => messageWaits(s)
    expect(waits(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 2 }))).toBe(true)
    expect(waits(state({ phase: "lent", model: "3.6", label: "Qwen" }))).toBe(true)
    expect(waits(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No." }))).toBe(true)
    expect(waits(state({ phase: "none" }, [download("active")]))).toBe(true)
    expect(waits(state({ phase: "none" }, [download("waiting")]))).toBe(true)
  })

  test("goes as usual with a model ready, the engine of another PC that answers, or nothing on the way", () => {
    expect(messageWaits(state({ phase: "ready", model: "3.6", label: "Qwen", where }))).toBe(false)
    expect(messageWaits(state({ phase: "remote", address: "a", models: [] }))).toBe(false)
    expect(messageWaits(state({ phase: "none" }))).toBe(false)
    expect(messageWaits(state({ phase: "none" }, [download("paused")]))).toBe(false)
    expect(messageWaits(undefined)).toBe(false)
  })

  test("is not sent with no model on the computer and none coming: there is nothing to leave with or to wait for", () => {
    const nothingHere = parseCatalog({ models: [entry("3.6", false, true)] })
    const oneHere = parseCatalog({ models: [entry("3.6", false, true), entry("ling", true, true)] })
    expect(noModel(state({ phase: "none" }), nothingHere)).toBe(true)
    // a download that stopped brings nothing
    expect(noModel(state({ phase: "none" }, [download("paused")]), nothingHere)).toBe(true)
    expect(noModel(state({ phase: "none" }, [download("failed")]), nothingHere)).toBe(true)
    // one on its way: the message waits for it instead
    expect(noModel(state({ phase: "none" }, [download("active")]), nothingHere)).toBe(false)
    expect(noModel(state({ phase: "none" }, [download("waiting")]), nothingHere)).toBe(false)
    // a model on the disk, though none is in use; the other PC's engine; a catalog not read yet
    expect(noModel(state({ phase: "none" }), oneHere)).toBe(false)
    expect(noModel(state({ phase: "remote", address: "a", models: [] }), nothingHere)).toBe(false)
    expect(noModel(state({ phase: "none" }), undefined)).toBe(false)
    expect(noModel(undefined, nothingHere)).toBe(false)
  })

  test("waits while the other PC's engine does not answer, and leaves when it answers or a model is ready", () => {
    const down = state({ phase: "remote", address: "a", models: [], reachable: false })
    expect(messageWaits(down)).toBe(true)
    expect(canSend(down)).toBe(false)
    expect(canSend(state({ phase: "remote", address: "a", models: [] }))).toBe(true)
    expect(canSend(state({ phase: "ready", model: "3.6", label: "Qwen", where }))).toBe(true)
    expect(canSend(state({ phase: "loading", model: "3.6", label: "Qwen", seconds: 2 }))).toBe(false)
    expect(canSend(undefined)).toBe(false)
  })
})

describe("the Home", () => {
  const nothingHere = parseCatalog({
    models: [entry("3.6", false, true, { recommended: true }), entry("70b", false, false)],
  })!
  const oneHere = parseCatalog({ models: [entry("3.6", true, true), entry("ling", false, true)] })!
  const engine = { ...download("active"), engine_only: true }

  test("«Cosa ho trovato» names the disk of the models by its drive, as the settings do, not by its folder", () => {
    expect(diskDrive("c:\\Users\\me\\Mango Code\\models")).toBe("C:")
    expect(diskDrive("/home/ada/models")).toBe("/home/ada/models")
  })

  test("the first start is when no model is on the computer", () => {
    expect(firstRun(state({ phase: "none" }), nothingHere)).toBe(true)
    expect(firstRun(state({ phase: "none" }), oneHere)).toBe(false)
    expect(firstRun(state({ phase: "none" }), undefined)).toBe(false)
    expect(firstRun(state({ phase: "remote", address: "a", models: [] }), nothingHere)).toBe(false)
  })

  test("welcome, then the download, the failed start inside the usual Home, the other PC that does not answer", () => {
    expect(homeView(state({ phase: "none" }), nothingHere)).toBe("welcome")
    expect(homeView(state({ phase: "none" }, [download("active")]), nothingHere)).toBe("downloading")
    expect(homeView(state({ phase: "failed", model: "3.6", label: "Qwen", reason: "No." }), oneHere)).toBe("usual")
    expect(homeView(state({ phase: "remote", address: "a", models: [], reachable: false }), nothingHere)).toBe("remote")
    expect(homeView(state({ phase: "remote", address: "a", models: [] }), nothingHere)).toBe("usual")
    expect(homeView(undefined, undefined)).toBe("usual")
  })

  test("models on the disk that wait for the engine the app came with are not a first start: the Home says it arrives", () => {
    // the catalog: no model present, as their engine is not there
    expect(firstRun(state({ phase: "none" }, [engine]), nothingHere)).toBe(false)
    expect(homeView(state({ phase: "none" }, [engine]), nothingHere)).toBe("engine")
    expect(homeView(state({ phase: "none" }, [{ ...engine, state: "failed" }]), nothingHere)).toBe("engine")
    // a model in use meanwhile (another engine): the Home as usual
    expect(homeView(state({ phase: "ready", model: "3.6", label: "Qwen", where }, [engine]), oneHere)).toBe("usual")
  })

  test("models that do not read are said so, never taken for none", () => {
    expect(homeView(state({ phase: "none" }), undefined, true)).toBe("unreadable")
    expect(homeView(state({ phase: "none" }), undefined)).toBe("usual")
    expect(homeView(state({ phase: "none" }), nothingHere, true)).toBe("welcome")
  })

  test("the proposed model is the catalog's, otherwise the first that fits; the chosen ones are weighed together", () => {
    expect(recommended(nothingHere)?.key).toBe("3.6")
    expect(recommended(parseCatalog({ models: [entry("70b", false, false), entry("ling", false, true)] })!)?.key).toBe(
      "ling",
    )
    expect(recommended(parseCatalog({ models: [entry("70b", false, false)] })!)).toBeUndefined()
    expect(chosenBytes(oneHere, ["3.6", "ling", "ghost"])).toBe(200)
  })
})

describe("the words", () => {
  test("a context is told in K of 1024 tokens, with a capital K", () => {
    expect(contextLabel(32768)).toBe("32K")
    expect(contextLabel(131072)).toBe("128K")
    expect(contextLabel(262144)).toBe("256K")
    expect(contextLabel(100000)).toBe("98K")
  })

  test("a wait: under a minute, minutes rounded up, whole hours, hours and minutes", () => {
    expect(etaParts(30)).toEqual({ kind: "lessThanMinute" })
    expect(etaParts(61)).toEqual({ kind: "minutes", count: 2 })
    expect(etaParts(7200)).toEqual({ kind: "hours", hours: 2 })
    expect(etaParts(3600 + 600)).toEqual({ kind: "hoursMinutes", hours: 1, minutes: 10 })
  })

  test("a project that is gone is told with the folder that held it", () => {
    expect(missingParent("C:\\Users\\Ada\\Desktop\\Progetti\\sito\\sito")).toBe("Progetti\\sito")
    expect(missingParent("C:/Progetti/sito")).toBe("C:\\Progetti")
  })
})
