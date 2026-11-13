import { describe, expect, test } from "bun:test"
import path from "node:path"
import { dict as en } from "@/i18n/en"
import { dict as it } from "@/i18n/it"
import { isSection, searchSettings, SECTIONS, SETTINGS_INDEX, type Found, type SettingsSection } from "./settings-index"

const found = (items: Partial<Found>[]) => items.map((item) => ({ section: "general" as const, title: "", ...item }))

describe("the search of the settings", () => {
  test("every word of the query, without accents and case, in the title or in the line under it", () => {
    const items = found([
      { section: "general", title: "Lingua", description: "La lingua dell'interfaccia" },
      { section: "models", title: "Dove gira", description: "Automatico, una scheda, processore" },
      { section: "help", title: "Novità della versione" },
    ])
    expect(searchSettings(items, "novita").map((item) => item.title)).toEqual(["Novità della versione"])
    expect(searchSettings(items, "UNA scheda").map((item) => item.title)).toEqual(["Dove gira"])
    expect(searchSettings(items, "lingua inglese")).toEqual([])
    expect(searchSettings(items, "   ")).toEqual([])
  })

  test("titles come first, then lines, each in the order of the sections", () => {
    const items = found([
      { section: "help", title: "Scheda di aiuto" },
      { section: "general", title: "Altro", description: "una scheda" },
      { section: "models", title: "Scheda video" },
    ])
    expect(searchSettings(items, "scheda").map((item) => item.title)).toEqual([
      "Scheda video",
      "Scheda di aiuto",
      "Altro",
    ])
  })

  test("every setting of the index has its text in both languages, and the sections are the six of the page", () => {
    expect(SECTIONS).toEqual(["models", "computer", "agent", "links", "general", "help"])
    for (const entry of SETTINGS_INDEX) {
      for (const key of [entry.title, entry.description, entry.words].filter((key) => key !== undefined)) {
        expect(it[key as keyof typeof it], String(key)).toBeString()
        expect(en[key as keyof typeof en], String(key)).toBeString()
      }
    }
    for (const section of SECTIONS)
      expect(
        SETTINGS_INDEX.some((entry) => entry.section === section),
        section,
      ).toBe(true)
  })

  test("the search finds the settings of Computer and Connections by their Italian words", () => {
    const items = SETTINGS_INDEX.map((entry) => ({
      section: entry.section,
      title: it[entry.title as keyof typeof it],
      description: entry.description ? it[entry.description as keyof typeof it] : undefined,
    }))
    const sections = (query: string) => searchSettings(items, query).map((item) => `${item.section}: ${item.title}`)
    expect(sections("usa per i modelli")).toEqual(["computer: Schede video"])
    expect(sections("ottimizza")).toEqual(["computer: Assetto su misura"])
    expect(sections("assetto")).toEqual(["computer: Assetto su misura"])
    expect(sections("presta motore")).toEqual(["links: Presta il motore ai miei PC"])
    expect(sections("altro pc")).toContain("links: Usa il motore di un altro PC")
    expect(sections("telefono")).toContain("links: Telefono")
    expect(sections("openrouter")).toEqual(["links: Cloud, a pagamento"])
    expect(sections("token")).toContain("links: Hugging Face")
  })

  test("a section in the address is one of the six", () => {
    expect(isSection("models")).toBe(true)
    expect(isSection("server")).toBe(false)
    expect(isSection(undefined)).toBe(false)
  })
})

describe("the search finds the settings of Agent, General and Help", () => {
  /** The index in a language, as the page builds it for the search. */
  const index = (dict: Record<string, string>): Found[] =>
    SETTINGS_INDEX.map((entry) => ({
      section: entry.section,
      title: dict[entry.title],
      description: entry.description ? dict[entry.description] : undefined,
      words: entry.words ? dict[entry.words] : undefined,
    }))
  const ask = (query: string, dict: Record<string, string> = it) =>
    searchSettings(index(dict), query).map((item) => `${item.section}: ${item.title}`)

  test("a word of a title or of its line leads to the row, in Italian", () => {
    expect(ask("mcp")).toContain("agent: Server MCP")
    expect(ask("skill")).toContain("agent: Skill")
    expect(ask("chrome")).toEqual(["agent: Dove naviga l'agente"])
    expect(ask("dettatura")).toEqual(["general: Dettatura"])
    expect(ask("tema scuro")).toEqual(["general: Tema"])
    expect(ask("permesso")).toEqual(["general: Serve un tuo permesso"])
    expect(ask("carattere").map((found) => found.split(": ")[0])).toEqual(["general", "general"])
    expect(ask("aggiorna")).toContain("help: Aggiorna da solo")
    expect(ask("registri")).toEqual(["help: Registri"])
    expect(ask("segnala")).toEqual(["help: Segnala un problema"])
    expect(ask("ingrandisci")).toEqual(["general: Grandezza"])
    expect(ask("grandezza")).toEqual(["general: Grandezza"])
  })

  test("the words a user writes that the page does not show lead to the row, in both languages", () => {
    const first = (query: string, dict: Record<string, string> = it) => ask(query, dict)[0]
    expect(ask("zoom")).toEqual(["general: Grandezza"])
    expect(ask("zoom", en)).toEqual(["general: Size"])
    expect(first("inglese")).toBe("general: Lingua")
    expect(first("english", en)).toBe("general: Language")
    expect(ask("microfono")).toEqual(["general: Dettatura"])
    expect(ask("microphone", en)).toEqual(["general: Dictation"])
    expect(ask("aggiornamento")).toEqual(["help: Controlla ora", "help: Aggiorna da solo"])
    expect(ask("updates", en)).toEqual(["help: Check for updates", "help: Update on its own"])
    expect(ask("qr")).toEqual(["links: Telefono"])
    expect(ask("qr", en)).toEqual(["links: Phone"])
    expect(ask("gpu")).toEqual(["computer: Schede video"])
    expect(ask("gpu", en)).toEqual(["computer: Graphics cards"])
    expect(ask("scheda video")).toEqual(["computer: Schede video"])
    expect(ask("cartella dei modelli")).toEqual(["models: Apri la cartella"])
    expect(ask("models folder", en)).toEqual(["models: Open the folder"])
    expect(ask("cpu")).toEqual(["computer: Processore e memoria"])
    expect(ask("notifiche")).toHaveLength(3)
    expect(ask("notifications", en)).toHaveLength(3)
    expect(ask("temperatura")).toEqual(["models: Stile delle risposte"])
    expect(ask("terminale")).toEqual(["general: Espandi le parti dello strumento Shell"])
    expect(ask("bug")).toEqual(["help: Segnala un problema"])
    expect(ask("rete")).toEqual(["links: Presta il motore ai miei PC", "links: Usa il motore di un altro PC"])
  })

  test("the three alerts answer to «suono» and «notifica», and only they", () => {
    const alerts = ["general: Risposta pronta", "general: Serve un tuo permesso", "general: Errore"]
    expect(ask("suono")).toEqual(alerts)
    expect(ask("notifica")).toEqual(alerts)
  })

  test("and in English", () => {
    expect(ask("mcp", en)).toContain("agent: MCP servers")
    expect(ask("update", en)).toEqual(["help: Check for updates", "help: Update on its own", "computer: Engine"])
    expect(ask("sound", en)).toEqual(["general: Answer ready", "general: Your permission is needed", "general: Error"])
  })
})

describe("the index and the page", () => {
  /** The files that draw each section. */
  const FILES: Record<SettingsSection, string[]> = {
    models: ["models.tsx", "other-model.tsx"],
    computer: ["computer.tsx"],
    agent: ["agent.tsx"],
    links: ["links.tsx"],
    general: ["general.tsx", "dictation.tsx"],
    help: ["help.tsx"],
  }
  const source = async (section: SettingsSection) =>
    (await Promise.all(FILES[section].map((file) => Bun.file(path.join(import.meta.dir, file)).text()))).join("\n")
  const keys = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1])
  /** The texts a section shows as the title of a row, a field or a group, or that a button is found by. */
  const shown = (text: string) => [
    ...keys(text, /title=\{language\.t\("([^"]+)"/g),
    // also a title that only some rows are found by: `data-found-title={cond ? undefined : language.t("…")}`
    ...keys(text, /data-found-title=\{[^}]*?language\.t\("([^"]+)"/g),
    ...keys(
      text,
      /(?:settings-v2-row-title|settings-field-title|settings-v2-section-title)"[^>]*>\{language\.t\("([^"]+)"/g,
    ),
    // the tables of titles: the rows of the Agent, the groups of Models, the alerts
    ...keys(text, /title: "([^"]+)"/g),
  ]
  /** Titles of rows that are not settings to find: a chooser of the section, a name with a value, a part of a form. */
  const NOT_INDEXED = new Set([
    "settings.prompt.project.title",
    "settings.computer.noGpu",
    "settings.help.update.title",
    "settings.help.report.screenshot.title",
    // only on a phone, in the builds that are not released
    "settings.general.row.mobileTitlebarBottom.title",
  ])

  test("every setting of the index is a title its section shows", async () => {
    for (const section of SECTIONS) {
      const titles = shown(await source(section))
      for (const entry of SETTINGS_INDEX.filter((entry) => entry.section === section))
        expect(titles, `${section}: ${entry.title}`).toContain(entry.title as string)
    }
  })

  test("every row a section shows is in the index, in that section", async () => {
    for (const section of SECTIONS) {
      const rows = keys(await source(section), /<(?:SettingsRowV2|LinkCard)[^>]*?title=\{language\.t\("([^"]+)"/gs)
      const indexed = SETTINGS_INDEX.filter((entry) => entry.section === section).map((entry) => entry.title as string)
      for (const row of rows.filter((row) => !NOT_INDEXED.has(row)))
        expect(indexed, `${section}: ${row}`).toContain(row)
    }
  })
})
