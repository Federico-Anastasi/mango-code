import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Harness } from "../harness"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Record } from "effect"
import type { ModelMessage, Tool } from "ai"
import type { Plugin } from "@/plugin"
import { mergeDeep } from "remeda"

const USER_AGENT = `opencode/${InstallationVersion}`

type PrepareInput = {
  readonly user: SessionV1.User
  readonly sessionID: string
  readonly parentSessionID?: string
  readonly model: Provider.Model
  readonly agent: Agent.Info
  readonly permission?: PermissionV1.Ruleset
  readonly system: string[]
  /** The working folder and the date: they change with the project and the day, so they end the system prompt. */
  readonly env?: string[]
  readonly messages: ModelMessage[]
  readonly small?: boolean
  readonly tools: Record<string, Tool>
  readonly provider: Provider.Info
  readonly plugin: Plugin.Interface
  readonly flags: RuntimeFlags.Info
  /** mango-code: the system prompt and the tools are the harness's own (`StreamInput.commands`). */
  readonly commands?: { system: string; stable: number }
}

export type Prepared = {
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, any>
  }
  readonly headers: Record<string, string>
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const prepare = Effect.fn("LLMRequestPrep.prepare")(function* (input: PrepareInput) {
  // mango-code: a harness of the user's can bring its own base prompt and its own words for the agent's tools. A request
  // of a `commands` harness's model outside its turn (a summary, a title) is made as the default harness makes it.
  const chosen = Harness.forModel(input.model.id, input.model.providerID)
  const harness = input.commands ? undefined : chosen.kind === "commands" ? Harness.definition(Harness.DEFAULT) : chosen
  // mango-code: a `commands` harness brings its own prompt: no base prompt, no agent text, no plugin
  const system = input.commands
    ? [input.commands.system]
    : [
        ...(input.agent.prompt ? [input.agent.prompt] : [Harness.basePrompt(harness!)]),
        ...input.system,
        ...(input.user.system ? [input.user.system] : []),
      ].filter((x) => x)
  if (!input.commands)
    yield* input.plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
  // after what the plugins add, so that the engine reuses the prompt it has already read up to these lines
  const stable = system.join("\n")
  const prompt = input.env?.length && !input.commands ? [stable, ...input.env].join("\n") : stable

  const variant =
    !input.small && input.model.variants && input.user.model.variant
      ? input.model.variants[input.user.model.variant]
      : {}
  const base = input.small ? ProviderTransform.smallOptions(input.model) : {}
  const options = mergeOptions(mergeOptions(mergeOptions(base, input.model.options), input.agent.options), variant)
  const messages: ModelMessage[] = [{ role: "system", content: prompt }, ...input.messages]

  const params = yield* input.plugin.trigger(
    "chat.params",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      temperature: input.model.capabilities.temperature ? input.agent.temperature : undefined,
      topP: input.agent.topP,
      topK: undefined,
      // the answer has no limit of its own: it may take what is left of the context (a plugin may still set one)
      maxOutputTokens: undefined,
      options,
    },
  )

  const { headers } = yield* input.plugin.trigger(
    "chat.headers",
    {
      sessionID: input.sessionID,
      agent: input.agent.name,
      model: input.model,
      provider: input.provider,
      message: input.user,
    },
    {
      headers: {},
    },
  )

  const tools = input.commands ? input.tools : Harness.describe(harness!, resolveTools(input))

  const requestHeaders: Prepared["headers"] = {
    ...(input.model.providerID === "mango"
      ? // the engine keeps the system prompt read up to here for the new conversations of every folder and day
        { "X-Mango-Stable-Prompt": String(input.commands?.stable ?? Buffer.byteLength(stable)) }
      : {
          "x-opencode-session-id": input.sessionID,
          ...(input.parentSessionID ? { "x-opencode-parent-session-id": input.parentSessionID } : {}),
          "x-session-affinity": input.sessionID,
          "X-Session-Id": input.sessionID,
          "User-Agent": USER_AGENT,
          ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
        }),
    ...input.model.headers,
    ...headers,
  }

  return {
    messages,
    // mango-code: the harness's tools keep its order
    tools: input.commands ? tools : Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b))),
    params,
    headers: requestHeaders,
  }
})

export function resolveTools(input: Pick<PrepareInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

export * as LLMRequestPrep from "./request"
