import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Permission } from "@/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { reason } from "@/tool/invalid"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMRequestPrep } from "./llm/request"
import { enqueueEngineRequest } from "@/provider/engine-queue"

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  /** The working folder and the date: they end the system prompt (`LLMRequestPrep.prepare`). */
  env?: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  // mango-code: the conversation of a `commands` harness: its prompt, the bytes of it that are the same for every
  // folder and day, and how many times a call the engine could not read is asked again. The agent adds nothing to it.
  commands?: { system: string; stable: number; retries: number }
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  Config.Service | Provider.Service | Plugin.Service | Permission.Service | EventV2Bridge.Service | RuntimeFlags.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [language, cfg, item] = yield* Effect.all(
        [provider.getLanguage(input.model), config.get(), provider.getProvider(input.model.providerID)],
        { concurrency: "unbounded" },
      )

      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        plugin,
        flags,
      })

      const bridge = yield* EffectBridge.make()
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // AI SDK owns provider execution and tool dispatch; LLMAISDK.toLLMEvents below normalizes
      // fullStream parts for the processor.
      return streamText({
        onError(error) {
          bridge.fork(
            Effect.logError("stream error", {
              providerID: input.model.providerID,
              modelID: input.model.id,
              "session.id": input.sessionID,
              small: (input.small ?? false).toString(),
              agent: input.agent.name,
              mode: input.agent.mode,
              error,
            }),
          )
        },
        async experimental_repairToolCall(failed) {
          const lower = failed.toolCall.toolName.toLowerCase()
          if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
            return {
              ...failed.toolCall,
              toolName: lower,
            }
          }
          return {
            ...failed.toolCall,
            input: JSON.stringify({
              tool: failed.toolCall.toolName,
              error: reason({
                tool: failed.toolCall.toolName,
                arguments: failed.toolCall.input,
                error: failed.error.message,
                limit: prepared.params.maxOutputTokens,
              }),
            }),
            toolName: "invalid",
          }
        },
        temperature: prepared.params.temperature,
        topP: prepared.params.topP,
        topK: prepared.params.topK,
        providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
        activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
        tools: prepared.tools,
        toolChoice: input.toolChoice,
        maxOutputTokens: prepared.params.maxOutputTokens,
        abortSignal: input.abort,
        headers: prepared.headers,
        maxRetries: input.retries ?? 0,
        messages: prepared.messages,
        model: wrapLanguageModel({
          model: language,
          middleware: [
            {
              specificationVersion: "v3" as const,
              async transformParams(args) {
                if (args.type === "stream") {
                  // @ts-expect-error
                  args.params.prompt = ProviderTransform.message(args.params.prompt, input.model)
                }
                return args.params
              },
            },
          ],
        }),
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          functionId: "session.llm",
          tracer: telemetryTracer,
          metadata: {
            userId: cfg.username ?? "unknown",
            sessionId: input.sessionID,
          },
        },
      })
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            // mango-code: the local engine serves one request at a time; while the stream is open
            // the conversation is queued or being served (see engine-queue.ts).
            if (input.model.providerID === "mango") {
              yield* Effect.acquireRelease(
                Effect.sync(() => enqueueEngineRequest(input.sessionID, { parentSessionID: input.parentSessionID })),
                (release) => Effect.sync(release),
              )
            }

            const result = yield* run({ ...input, abort: ctrl.signal })

            const state = LLMAISDK.adapterState()
            return Stream.fromAsyncIterable(result.fullStream, (e) =>
              e instanceof Error ? e : new Error(String(e)),
            ).pipe(
              Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
              Stream.flatMap((events) => Stream.fromIterable(events)),
            )
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [Config.node, Provider.node, Plugin.node, Permission.node, EventV2Bridge.node, RuntimeFlags.node],
})

export * as LLM from "./llm"
