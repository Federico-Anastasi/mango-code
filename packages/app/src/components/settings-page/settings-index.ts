// mango-code: the sections of the settings page and what its search finds. Every setting is listed here with the
// section that holds it: a row added to a section is added here too, or the search does not find it (the test reads the
// sections' files). The title is the text the page shows for the row (its title, or `data-found-title` on a button whose
// text says more), which the page also uses to bring the row into view.

import type { useLanguage } from "@/context/language"

/** A key of the interface's texts: a title or a line of the index that is not one fails the type check. */
type TextKey = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

export const SECTIONS = ["models", "computer", "agent", "links", "general", "help"] as const
export type SettingsSection = (typeof SECTIONS)[number]

export function isSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SECTIONS as readonly string[]).includes(value)
}

/**
 * A setting the search finds: its section, the keys of its title and of the line under it, and of the other words a
 * user writes for it, which the page does not show («zoom» for «Grandezza»).
 */
export type IndexEntry = { section: SettingsSection; title: TextKey; description?: TextKey; words?: TextKey }

export const SETTINGS_INDEX: IndexEntry[] = [
  { section: "models", title: "settings.models.section.present" },
  { section: "models", title: "settings.models.section.arriving" },
  { section: "models", title: "settings.models.section.catalog" },
  { section: "models", title: "settings.models.where.title", description: "settings.models.where.search" },
  { section: "models", title: "settings.models.context.title", description: "settings.models.context.description" },
  {
    section: "models",
    title: "settings.models.style.title",
    description: "settings.models.style.search",
    words: "settings.words.style",
  },
  {
    section: "models",
    title: "settings.models.reasoning.title",
    description: "settings.models.reasoning.description",
    words: "settings.words.reasoning",
  },
  { section: "models", title: "settings.models.default.action" },
  { section: "models", title: "settings.models.remove.search", words: "settings.words.remove" },
  {
    section: "models",
    title: "settings.models.other.title",
    description: "settings.models.other.description",
    words: "settings.words.other",
  },
  { section: "models", title: "settings.models.folder.open", words: "settings.words.folder" },
  {
    section: "computer",
    title: "settings.computer.gpus",
    description: "settings.computer.useForModels",
    words: "settings.words.gpus",
  },
  {
    section: "computer",
    title: "settings.computer.small.section",
    description: "settings.computer.small.one.description",
  },
  { section: "computer", title: "settings.computer.cpu", words: "settings.words.cpu" },
  {
    section: "computer",
    title: "settings.computer.engine",
    description: "settings.computer.updateEngine",
    words: "settings.words.engine",
  },
  { section: "computer", title: "settings.computer.tailored", description: "settings.computer.optimize" },
  {
    section: "agent",
    title: "settings.prompt.title",
    description: "settings.agent.prompt.search",
    words: "settings.words.prompt",
  },
  { section: "agent", title: "settings.agent.tools.title", description: "settings.agent.tools.description" },
  { section: "agent", title: "settings.agent.mcp.title", description: "settings.agent.mcp.description" },
  { section: "agent", title: "settings.agent.skills.title", description: "settings.agent.skills.description" },
  {
    section: "agent",
    title: "settings.agent.instructions.title",
    description: "settings.agent.instructions.description",
    words: "settings.words.instructions",
  },
  {
    section: "agent",
    title: "settings.agent.web.where.title",
    description: "settings.agent.web.where.search",
    words: "settings.words.browser",
  },
  {
    section: "links",
    title: "settings.links.phone.title",
    description: "settings.links.phone.line",
    words: "settings.words.phone",
  },
  {
    section: "links",
    title: "settings.links.share.title",
    description: "settings.links.share.line",
    words: "settings.words.network",
  },
  {
    section: "links",
    title: "settings.links.remote.title",
    description: "settings.links.remote.line",
    words: "settings.words.network",
  },
  { section: "links", title: "settings.links.cloud.title", description: "settings.links.cloud.line" },
  { section: "links", title: "settings.token.title", description: "settings.token.description" },
  {
    section: "general",
    title: "settings.general.row.language.title",
    description: "settings.general.row.language.description",
    words: "settings.words.language",
  },
  { section: "general", title: "settings.general.theme.title", description: "settings.general.theme.search" },
  {
    section: "general",
    title: "settings.general.row.zoom.title",
    description: "settings.general.row.zoom.search",
    words: "settings.words.zoom",
  },
  { section: "general", title: "settings.dictation.row.title", words: "settings.words.dictation" },
  {
    section: "general",
    title: "settings.general.reasoning.title",
    description: "settings.general.row.reasoningSummaries.description",
  },
  {
    section: "general",
    title: "settings.general.alerts.agent",
    description: "settings.general.alerts.line",
    words: "settings.words.alerts",
  },
  {
    section: "general",
    title: "settings.general.alerts.permissions",
    description: "settings.general.alerts.line",
    words: "settings.words.alerts",
  },
  {
    section: "general",
    title: "settings.general.alerts.errors",
    description: "settings.general.alerts.line",
    words: "settings.words.alerts",
  },
  {
    section: "general",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    words: "settings.words.font",
  },
  {
    section: "general",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    words: "settings.words.font",
  },
  {
    section: "general",
    title: "settings.general.row.shellToolPartsExpanded.title",
    description: "settings.general.row.shellToolPartsExpanded.description",
    words: "settings.words.shell",
  },
  {
    section: "general",
    title: "settings.general.row.editToolPartsExpanded.title",
    description: "settings.general.row.editToolPartsExpanded.description",
    words: "settings.words.edits",
  },
  {
    section: "help",
    title: "settings.help.update.check",
    description: "settings.help.update.description",
    words: "settings.words.updates",
  },
  {
    section: "help",
    title: "settings.help.automatic.title",
    description: "settings.help.automatic.description",
    words: "settings.words.updates",
  },
  { section: "help", title: "settings.help.site.title", description: "settings.help.site.description" },
  {
    section: "help",
    title: "settings.help.report.title",
    description: "settings.help.report.row",
    words: "settings.words.report",
  },
  { section: "help", title: "settings.help.logs.title", description: "settings.help.logs.description" },
]

/** A result of the search: the section, the title to show and to bring into view, the line under it, its other words. */
export type Found = { section: SettingsSection; title: string; description?: string; words?: string }

/** Lower case and without accents: «modalità» is found writing «modalita». */
export function fold(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/**
 * The settings whose title, line under it and other words hold every word of `query`, in the order of the sections;
 * titles that match come before the others. `items` are already in the interface's language.
 */
export function searchSettings(items: Found[], query: string): Found[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const holds = (value: string | undefined) => !!value && words.every((word) => fold(value).includes(word))
  const order = (found: Found) => SECTIONS.indexOf(found.section)
  const inTitle = items.filter((item) => holds(item.title))
  const inLine = items.filter(
    (item) => !holds(item.title) && holds(`${item.title} ${item.description ?? ""} ${item.words ?? ""}`),
  )
  return [...inTitle.toSorted((a, b) => order(a) - order(b)), ...inLine.toSorted((a, b) => order(a) - order(b))]
}
