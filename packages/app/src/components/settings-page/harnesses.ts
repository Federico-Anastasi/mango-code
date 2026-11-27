// mango-code: the harnesses of the agent (its route `/mango/harness`, session/harness.ts), read by the Agent section and
// by a model's detail, which chooses one.
import { createResource } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { authHeaders } from "@/utils/server"

export type HarnessListed = { id: string; name: string; fixed: boolean; kind?: string; from?: string; error?: string }
export type HarnessList = { default: string; harnesses: HarnessListed[] }

export type HarnessHook = { on: boolean; every?: number; times?: number }
export type HarnessShown = {
  id: string
  name: string
  fixed: boolean
  kind: string
  from?: string
  prompt: string
  tools: Record<string, string>
  hooks: Record<string, HarnessHook>
  texts: Record<string, string>
  /** The texts of the summary of a long conversation, by name (`COMPACTION_TEXTS` of the agent). */
  compaction: Record<string, string>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function parseListed(value: unknown): HarnessListed | undefined {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.fixed !== "boolean")
    return
  const text = (key: string) => (typeof value[key] === "string" ? { [key]: value[key] as string } : {})
  return { id: value.id, name: value.name, fixed: value.fixed, ...text("kind"), ...text("from"), ...text("error") }
}

/** From the response of `GET /mango/harness`; `undefined` if it is not the expected one. */
export function parseHarnessList(body: unknown): HarnessList | undefined {
  if (!isObject(body) || typeof body.default !== "string" || !Array.isArray(body.harnesses)) return
  const harnesses = body.harnesses.map(parseListed)
  if (harnesses.some((h) => !h)) return
  return { default: body.default, harnesses: harnesses as HarnessListed[] }
}

/** From the response of `GET /mango/harness?id=`; `undefined` if it is not the expected one. */
export function parseHarness(body: unknown): HarnessShown | undefined {
  if (!isObject(body)) return
  const { id, name, fixed, kind, prompt, tools, hooks, texts, compaction } = body
  if (typeof id !== "string" || typeof name !== "string" || typeof fixed !== "boolean" || typeof kind !== "string") return
  if (typeof prompt !== "string" || !isObject(tools) || !isObject(hooks) || !isObject(texts) || !isObject(compaction)) return
  const strings = (record: Record<string, unknown>) => Object.values(record).every((v) => typeof v === "string")
  const hook = (v: unknown) => isObject(v) && typeof v.on === "boolean"
  if (!strings(tools) || !strings(texts) || !strings(compaction) || !Object.values(hooks).every(hook)) return
  return {
    id,
    name,
    fixed,
    kind,
    ...(typeof body.from === "string" ? { from: body.from } : {}),
    prompt,
    tools: tools as Record<string, string>,
    hooks: hooks as Record<string, HarnessHook>,
    texts: texts as Record<string, string>,
    compaction: compaction as Record<string, string>,
  }
}

/** A call to one of the agent's routes; an error of the server is thrown with its message, not ignored. */
export function useAgentCall() {
  const serverSDK = useServerSDK()
  return async (path: string, query: Record<string, string>, init?: RequestInit): Promise<unknown> => {
    const sdk = serverSDK()
    const headers = { "Content-Type": "application/json", ...authHeaders(sdk.server.http) }
    const url = new URL(path, sdk.url)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    const response = await fetch(url, { ...init, headers })
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined
    if (!response.ok) throw new Error(body?.error ?? `${response.status}`)
    return body
  }
}

/** The list of the harnesses, read when asked and again with `refetch`. It never throws where it is read: until it is
 *  there it is `undefined`, and `failed` says why it could not be read. */
export function createHarnessList() {
  const call = useAgentCall()
  const [list, actions] = createResource(async () => {
    const read = parseHarnessList(await call("/mango/harness", {}))
    if (!read) throw new Error("the list of the harnesses is not what was expected")
    return read
  })
  const ready = () => (list.state === "ready" || list.state === "refreshing" ? list() : undefined)
  const failed = () => (list.state === "errored" ? String((list.error as Error)?.message ?? list.error) : undefined)
  return [ready, { ...actions, failed }] as const
}
