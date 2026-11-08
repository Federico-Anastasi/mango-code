// mango-code: how many tokens each prompt item weighs (tool, MCP server, skill, instructions file, plugin). The engine
// does the counting, with the tokenizer of the running model (`POST /tokenize`, through the engine manager): no
// estimates. Where there is no measurement (engine off, item never seen) the settings page says "not measured".
// Measurements are kept in memory, per working folder and model: another model has another tokenizer, and the
// instructions, skills and servers change from folder to folder.

import path from "node:path"
import { engineOriginUrl } from "@/provider/engine-timings"

/** An item with the text it adds to the prompt; without text (a server that is not connected) it cannot be measured. */
export type Item = { kind: string; name: string; text?: string }

type Measurements = { model: string; tokens: Map<string, number> }

const measurements = new Map<string, Measurements>()
const folderKey = (directory: string) => path.resolve(directory).toLowerCase()
const itemKey = (kind: string, name: string) => `${kind}\u0000${name}`

/** The tokens of an item, or `undefined` if it has not been measured for this folder and this model. */
export function tokens(directory: string, model: string, kind: string, name: string): number | undefined {
  const known = measurements.get(folderKey(directory))
  return known?.model === model ? known.tokens.get(itemKey(kind, name)) : undefined
}

async function count(text: string): Promise<number> {
  const origin = engineOriginUrl()
  if (!origin) throw new Error("the engine address is not known: no request to the local model yet")
  const response = await fetch(`${origin}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`/tokenize answered ${response.status}`)
  const body = (await response.json()) as { tokens?: unknown }
  if (!Array.isArray(body.tokens)) throw new Error("/tokenize did not answer with a list of tokens")
  return body.tokens.length
}

const PARALLEL = 8

/**
 * Measures the items and remembers them per folder and model. With the same model the measured items are added to the
 * ones already known (a disabled plugin brings no text, but its earlier weight is still valid); with another model it
 * starts again. An item that cannot be measured stays unmeasured and the reason goes in `errors`.
 */
export async function measure(directory: string, model: string, items: Item[]) {
  const results: Record<string, number> = {}
  const errors: string[] = []
  const queue = items.filter((item): item is Item & { text: string } => item.text !== undefined)
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let item = queue.pop(); item; item = queue.pop()) {
        try {
          results[itemKey(item.kind, item.name)] = await count(item.text)
        } catch (e) {
          errors.push(`${item.kind} ${item.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }),
  )
  const existing = measurements.get(folderKey(directory))
  const known = existing?.model === model ? existing.tokens : new Map<string, number>()
  for (const [key, n] of Object.entries(results)) known.set(key, n)
  measurements.set(folderKey(directory), { model, tokens: known })
  return { results, errors }
}

// What a plugin adds to the conversation messages (the reminder) exists only while the plugin runs: it is collected
// there and measured with the first request. Once a conversation is measured nothing more is collected.
const additions = new Map<string, Map<string, string>>()
const measured = new Set<string>()

/** A plugin that runs without adding anything weighs zero; one message after another does not erase the text already seen. */
export function recordPlugin(sessionID: string | undefined, plugin: string, texts: string[]) {
  if (!sessionID || measured.has(sessionID)) return
  const session = additions.get(sessionID) ?? new Map<string, string>()
  if (texts.length > 0 || !session.has(plugin)) session.set(plugin, texts.join("\n"))
  additions.set(sessionID, session)
}

/** What the plugins added to the messages of a conversation; from here on nothing more is collected. */
export function takePlugins(sessionID: string): Map<string, string> | undefined {
  measured.add(sessionID)
  const session = additions.get(sessionID)
  additions.delete(sessionID)
  return session
}

export * as PromptMeasurement from "./prompt-measurement"
