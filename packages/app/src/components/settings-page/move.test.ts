import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { dict as it } from "@/i18n/it"
import type { MangoMovePreview, MangoPlacePreview } from "@/utils/mango-desktop"
import { folderAsk, modelAsk, moveOf, moveProgress, pathParts } from "./move"

const GB = 1024 ** 3

/** The words of the interface as the app shows them, in one language. */
function words(dict: Record<string, string>, locale: string) {
  const fill = (text: string, params: Record<string, unknown> = {}) =>
    text.replace(/{{\s*([^}]+?)\s*}}/g, (_, key: string) => String(params[key]))
  return {
    t: ((key: string, params?: Record<string, unknown>) => fill(dict[key], params)) as never,
    plural: ((key: string, count: number, params?: Record<string, unknown>) =>
      fill(dict[`${key}.${new Intl.PluralRules(locale).select(count)}`] ?? dict[`${key}.other`], { ...params, count })) as never,
    intl: () => locale,
  }
}
const italian = words(it, "it")
const english = words(en, "en")

const preview = (over: Partial<MangoMovePreview> = {}): MangoMovePreview => ({
  from: "C:\\Users\\Anna\\AppData\\Local\\MangoCode\\models",
  to: "E:\\Modelli",
  files: 14,
  bytes: 41 * GB,
  free_bytes: 820 * GB,
  same_volume: false,
  links: [],
  model_links: [],
  hard_links: [],
  partial_files: 0,
  foreign_files: 0,
  staying: null,
  destination: "empty",
  warning: null,
  refusal: null,
  move_refusal: null,
  ...over,
})

const place = (over: Partial<MangoPlacePreview> = {}): MangoPlacePreview => ({
  model: "ling",
  files: 1,
  bytes: 5 * GB,
  free_bytes: 300 * GB,
  same_volume: false,
  staying: [],
  warning: null,
  refusal: null,
  move_refusal: null,
  ...over,
})

describe("the question before moving the models folder", () => {
  test("another disk: size, models, free space, what is done, what stops, the restart", () => {
    const ask = folderAsk(preview(), 7, italian)
    expect(ask.title).toBe("Spostare i modelli in E:\\Modelli?")
    expect(ask.paragraphs).toEqual([
      "41 GB, 7 modelli. Su E: ci sono 820 GB liberi. È un altro disco: copio i modelli, li controllo e solo dopo tolgo quelli vecchi. Durante lo spostamento il modello e gli scaricamenti sono fermi; alla fine Mango Code si riavvia.",
    ])
    expect(ask.action).toBe("move")
    expect(ask.paths).toEqual(["E:\\Modelli"])
  })

  test("the same disk: no free space, «sposto e basta»", () => {
    const ask = folderAsk(preview({ same_volume: true, to: "C:\\Modelli" }), 1, italian)
    expect(ask.paragraphs[0]).toBe(
      "41 GB, 1 modello. È lo stesso disco: sposto e basta. Durante lo spostamento il modello e gli scaricamenti sono fermi; alla fine Mango Code si riavvia.",
    )
    expect(ask.action).toBe("move")
  })

  test("without the number of models, only the size", () => {
    expect(folderAsk(preview(), undefined, italian).paragraphs[0]).toStartWith("41 GB. Su E: ci sono")
  })

  test("a network or removable disk adds one paragraph and does not block", () => {
    const ask = folderAsk(preview({ warning: "È un disco di rete: i modelli si leggono più lentamente." }), 7, italian)
    expect(ask.paragraphs).toHaveLength(2)
    expect(ask.paragraphs[1]).toBe("È un disco di rete: i modelli si leggono più lentamente.")
    expect(ask.action).toBe("move")
  })

  test("not enough space: the sentence says what is free and what is needed, and there is nothing to press", () => {
    const ask = folderAsk(
      preview({ free_bytes: 30 * GB, move_refusal: "sul disco di E:\\Modelli non c'è spazio" }),
      7,
      italian,
    )
    expect(ask.paragraphs[0]).toBe("41 GB, 7 modelli. Su E: ci sono 30 GB liberi, ne servono 42 GB.")
    expect(ask.action).toBeUndefined()
  })

  test("a folder with files of its own is not merged: it can be used as it is", () => {
    const ask = folderAsk(
      preview({ destination: "has_files", move_refusal: "La cartella ha dei file suoi." }),
      7,
      italian,
    )
    expect(ask.title).toBe("E:\\Modelli contiene già dei file")
    expect(ask.paragraphs).toEqual([
      "Non unisco due cartelle. Posso usarla così com'è: i modelli che ci sono restano, quelli di adesso rimangono in C:\\Users\\Anna\\AppData\\Local\\MangoCode\\models e non li vedo più.",
    ])
    expect(ask.action).toBe("use")
    expect(ask.paths).toEqual(["E:\\Modelli", "C:\\Users\\Anna\\AppData\\Local\\MangoCode\\models"])
    const network = folderAsk(
      preview({ destination: "has_files", move_refusal: "La cartella ha dei file suoi.", warning: "È un disco di rete." }),
      7,
      italian,
    )
    expect(network.paragraphs.at(-1)).toBe("È un disco di rete.")
  })

  test("a folder that cannot be the models folder says why and offers nothing", () => {
    const ask = folderAsk(preview({ refusal: "Questa è già la cartella dei modelli." }), 7, italian)
    expect(ask.title).toBe("Non posso usare E:\\Modelli")
    expect(ask.paragraphs).toEqual(["Questa è già la cartella dei modelli."])
    expect(ask.action).toBeUndefined()
  })

  test("nothing to move, links that keep their models, files that are not Mango Code's", () => {
    expect(folderAsk(preview({ files: 0, bytes: 0, same_volume: true }), 0, italian).paragraphs[0]).toBe(
      "Non c'è niente da spostare. Durante lo spostamento il modello e gli scaricamenti sono fermi; alla fine Mango Code si riavvia.",
    )
    const ask = folderAsk(
      preview({ model_links: ["linked"], links: ["linked"], staying: "1 file che non è di Mango Code resta dov'è." }),
      7,
      italian,
    )
    expect(ask.paragraphs.slice(1)).toEqual([
      "Restano dove sono, con i modelli che contengono: linked.",
      "1 file che non è di Mango Code resta dov'è.",
    ])
  })

  test("in English", () => {
    expect(folderAsk(preview(), 2, english).paragraphs[0]).toBe(
      "41 GB, 2 models. E: has 820 GB free. It is another disk: I copy the models, check them and only then remove the old ones. While it moves, the model and the downloads are stopped; at the end Mango Code restarts.",
    )
  })
})

describe("the question before putting one model elsewhere", () => {
  const target = { name: "Ling", folder: "D:\\Veloce", back: false }

  test("another disk: no restart, only that model stops", () => {
    const ask = modelAsk(place(), target, italian)
    expect(ask.title).toBe("Spostare Ling in D:\\Veloce?")
    expect(ask.paragraphs).toEqual([
      "5 GB. Su D: ci sono 300 GB liberi. È un altro disco: copio i file, li controllo e solo dopo tolgo quelli vecchi. Durante lo spostamento questo modello e i suoi scaricamenti sono fermi.",
    ])
    expect(ask.action).toBe("move")
  })

  test("the same disk, and not enough space", () => {
    expect(modelAsk(place({ same_volume: true }), target, italian).paragraphs[0]).toBe(
      "5 GB. È lo stesso disco: sposto e basta. Durante lo spostamento questo modello e i suoi scaricamenti sono fermi.",
    )
    const full = modelAsk(place({ free_bytes: 2 * GB, move_refusal: "no space" }), target, italian)
    expect(full.paragraphs[0]).toBe("5 GB. Su D: ci sono 2 GB liberi, ne servono 6 GB.")
    expect(full.action).toBeUndefined()
  })

  test("back in the models folder, and a refusal", () => {
    expect(modelAsk(place(), { ...target, folder: "C:\\Modelli", back: true }, italian).title).toBe(
      "Riportare Ling in C:\\Modelli?",
    )
    const refused = modelAsk(place({ refusal: "Il modello è già lì." }), target, italian)
    expect(refused).toMatchObject({ title: "Non posso usare D:\\Veloce", paragraphs: ["Il modello è già lì."] })
    expect(refused.action).toBeUndefined()
  })
})

test("the paths of a sentence are told apart, the longest first", () => {
  expect(pathParts("In E:\\Modelli e in E:\\Modelli\\vecchi.", ["E:\\Modelli", "E:\\Modelli\\vecchi"])).toEqual([
    { text: "In ", path: false },
    { text: "E:\\Modelli", path: true },
    { text: " e in ", path: false },
    { text: "E:\\Modelli\\vecchi", path: true },
    { text: ".", path: false },
  ])
  expect(pathParts("Niente.", ["E:\\Modelli"])).toEqual([{ text: "Niente.", path: false }])
  expect(pathParts("Un (punto)", ["(punto)"])).toEqual([
    { text: "Un ", path: false },
    { text: "(punto)", path: true },
  ])
})

describe("how far a move is", () => {
  const moving = (progress: unknown) => ({ status: "moving" as const, to: "E:\\Modelli", model: null, progress }) as never
  const at = (stage: string, over: object = {}) =>
    moving({ stage, done_bytes: 12 * GB, total_bytes: 41 * GB, done_files: 3, total_files: 14, current: "Qwen/model-Q4.gguf", ...over })

  test("before the first file: the model and the downloads are being stopped", () => {
    expect(moveProgress(moving(null), italian)).toEqual({ value: 0, line: "Fermo il modello e gli scaricamenti", cancellable: true })
  })

  test("copying: bytes of the total and the file", () => {
    const copying = moveProgress(at("copying"), italian)
    expect(copying.line).toBe("12 GB di 41 GB · model-Q4.gguf")
    expect(Math.round(copying.value)).toBe(29)
    expect(copying.cancellable).toBe(true)
  })

  test("checking, renaming on the same disk, saving, removing", () => {
    expect(moveProgress(at("verifying"), italian).line).toBe("12 GB di 41 GB · Controllo model-Q4.gguf")
    const renaming = moveProgress(at("moving", { done_bytes: 0, total_bytes: 0 }), italian)
    expect(renaming).toEqual({ value: (3 / 14) * 100, line: "3 di 14 file", cancellable: true })
    expect(moveProgress(at("saving"), italian)).toEqual({ value: 100, line: "Salvo la scelta", cancellable: true })
    expect(moveProgress(at("removing"), italian)).toEqual({ value: 100, line: "Tolgo i vecchi file", cancellable: false })
  })

  test("a total of nothing is no progress, not a division by zero", () => {
    expect(moveProgress(at("copying", { total_bytes: 0, done_bytes: 0 }), italian).value).toBe(0)
  })
})

describe("which row a move belongs to", () => {
  const folderMove = { status: "moving", to: "E:\\Modelli", model: null, progress: null } as const
  const modelMove = { status: "moving", to: "D:\\Veloce", model: "ling", progress: null } as const

  test("one under way, by what it moves", () => {
    expect(moveOf(folderMove, undefined, "folder")).toBe(folderMove)
    expect(moveOf(folderMove, undefined, "ling")).toBeUndefined()
    expect(moveOf(modelMove, undefined, "ling")).toBe(modelMove)
    expect(moveOf(modelMove, "folder", "folder")).toBeUndefined()
  })

  test("waiting for the app to start again: the folder's", () => {
    expect(moveOf({ status: "moved", left: ["linked"] }, undefined, "folder")).toEqual({ status: "moved", left: ["linked"] })
    expect(moveOf({ status: "restarting" }, undefined, "ling")).toBeUndefined()
  })

  test("the end of the last one: the row the user started it from; one found when the page opened, nobody's", () => {
    const failed = { status: "failed", message: "Un altro programma usa un file." } as const
    expect(moveOf(failed, "ling", "ling")).toBe(failed)
    expect(moveOf(failed, "ling", "folder")).toBeUndefined()
    expect(moveOf(failed, undefined, "folder")).toBeUndefined()
    expect(moveOf({ status: "cancelled" }, "folder", "folder")).toEqual({ status: "cancelled" })
    expect(moveOf({ status: "idle" }, "folder", "folder")).toBeUndefined()
  })
})
