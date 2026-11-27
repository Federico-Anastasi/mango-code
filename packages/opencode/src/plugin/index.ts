import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type {
  Hooks,
  PluginInput,
  Plugin as PluginInstance,
  PluginModule,
  WorkspaceAdapter as PluginWorkspaceAdapter,
} from "@opencode-ai/plugin"
import { Config } from "@/config/config"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { ServerAuth } from "@/server/auth"
import { Session } from "@/session/session"
import { NamedError } from "@opencode-ai/core/util/error"
import { Effect, Layer, Context } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { errorMessage } from "@/util/error"
import { PluginLoader } from "./loader"
import { parsePluginSpecifier, readPluginId, readV1Plugin, resolvePluginId } from "./shared"
import { registerAdapter } from "@/control-plane/adapters"
import type { WorkspaceAdapter } from "@/control-plane/types"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { PromptSettings } from "@/session/settings"
import { Harness } from "@/session/harness"
import { PromptMeasurement } from "@/session/prompt-measurement"

type State = {
  hooks: Hooks[]
}

// Hook names that follow the (input, output) => Promise<void> trigger pattern
type TriggerName = {
  [K in keyof Hooks]-?: NonNullable<Hooks[K]> extends (input: any, output: any) => Promise<void> ? K : never
}[keyof Hooks]

export interface Interface {
  readonly trigger: <
    Name extends TriggerName,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => Effect.Effect<Output>
  readonly list: () => Effect.Effect<Hooks[]>
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

function isServerPlugin(value: unknown): value is PluginInstance {
  return typeof value === "function"
}

function getServerPlugin(value: unknown) {
  if (isServerPlugin(value)) return value
  if (!value || typeof value !== "object" || !("server" in value)) return
  if (!isServerPlugin(value.server)) return
  return value.server
}

function getLegacyPlugins(mod: Record<string, unknown>) {
  const seen = new Set<unknown>()
  const result: PluginInstance[] = []

  for (const entry of Object.values(mod)) {
    if (seen.has(entry)) continue
    seen.add(entry)
    const plugin = getServerPlugin(entry)
    if (!plugin) throw new TypeError("Plugin export is not a function")
    result.push(plugin)
  }

  return result
}

// mango-code: the name under which an external plugin is an entry of the prompt settings (see session/settings.ts).
const names = new WeakMap<Hooks, string>()

/** The name of an external plugin, or `undefined` for built-in plugins. */
export const pluginNameOf = (hook: Hooks) => names.get(hook)

async function applyPlugin(load: PluginLoader.Loaded, input: PluginInput, hooks: Hooks[]) {
  const name = PromptSettings.pluginName(load.spec)
  const addHook = (hook: Hooks) => {
    names.set(hook, name)
    hooks.push(hook)
  }
  const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
  if (plugin) {
    await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
    addHook(await (plugin as PluginModule).server(input, load.options))
    return
  }

  for (const server of getLegacyPlugins(load.mod)) {
    addHook(await server(input, load.options))
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Plugin.state")(function* (ctx) {
        const hooks: Hooks[] = []
        const bridge = yield* EffectBridge.make()

        function publishPluginError(message: string) {
          bridge.fork(events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() }))
        }

        const { Server } = yield* Effect.promise(() => import("../server/server"))

        const serverUrl = Server.url
        const client = createOpencodeClient({
          baseUrl: serverUrl?.toString() ?? "http://localhost:4096",
          directory: ctx.directory,
          headers: ServerAuth.headers(),
          ...(serverUrl ? {} : { fetch: async (...args) => Server.Default().app.fetch(...args) }),
        })
        const cfg = yield* config.get()
        const input: PluginInput = {
          client,
          project: ctx.project,
          worktree: ctx.worktree,
          directory: ctx.directory,
          experimental_workspace: {
            register(type: string, adapter: PluginWorkspaceAdapter) {
              registerAdapter(ctx.project.id, type, adapter as WorkspaceAdapter)
            },
          },
          get serverUrl(): URL {
            return Server.url ?? new URL("http://localhost:4096")
          },
          // @ts-expect-error
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }

        const plugins = flags.pure ? [] : (cfg.plugin_origins ?? [])
        if (flags.pure && cfg.plugin_origins?.length) {
        }
        if (plugins.length) yield* config.waitForDependencies()

        const loaded = yield* Effect.promise(() =>
          PluginLoader.loadExternal({
            items: plugins,
            kind: "server",
            report: {
              start(candidate) {},
              missing(candidate, _retry, message) {},
              error(candidate, _retry, stage, error, resolved) {
                const spec = candidate.plan.spec
                const cause = error instanceof Error ? (error.cause ?? error) : error
                const message = stage === "load" ? errorMessage(error) : errorMessage(cause)

                if (stage === "install") {
                  const parsed = parsePluginSpecifier(spec)
                  publishPluginError(`Failed to install plugin ${parsed.pkg}@${parsed.version}: ${message}`)
                  return
                }

                if (stage === "compatibility") {
                  publishPluginError(`Plugin ${spec} skipped: ${message}`)
                  return
                }

                if (stage === "entry") {
                  publishPluginError(`Failed to load plugin ${spec}: ${message}`)
                  return
                }

                publishPluginError(`Failed to load plugin ${spec}: ${message}`)
              },
            },
          }),
        )
        for (const load of loaded) {
          if (!load) continue

          // Keep plugin execution sequential so hook registration and execution
          // order remains deterministic across plugin runs.
          yield* Effect.tryPromise({
            try: () => applyPlugin(load, input, hooks),
            catch: (err) => {
              const message = errorMessage(err)
              return message
            },
          }).pipe(
            Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error })),
            Effect.catch(() => {
              // TODO: make proper events for this
              // events.publish(Session.Event.Error, {
              //   error: new NamedError.Unknown({
              //     message: `Failed to load plugin ${load.spec}: ${message}`,
              //   }).toObject(),
              // })
              return Effect.void
            }),
          )
        }

        // Notify plugins of current config
        for (const hook of hooks) {
          yield* Effect.tryPromise({
            try: () => Promise.resolve((hook as any).config?.(cfg)),
            catch: errorMessage,
          }).pipe(
            Effect.tapError((error) => Effect.logError("plugin config hook failed", { error })),
            Effect.ignore,
          )
        }

        const unsubscribe = yield* events.listen((event) => {
          if (event.location?.directory !== ctx.directory) return Effect.void
          return Effect.sync(() => {
            for (const hook of hooks) {
              void hook["event"]?.({ event: { id: event.id, type: event.type, properties: event.data } as any })
            }
          })
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            hooks,
            (hook) =>
              Effect.tryPromise({
                try: () => Promise.resolve(hook.dispose?.()),
                catch: errorMessage,
              }).pipe(
                Effect.tapError((error) => Effect.logError("plugin dispose hook failed", { error })),
                Effect.ignore,
              ),
            { discard: true },
          ),
        )

        return { hooks }
      }),
    )

    const trigger = Effect.fn("Plugin.trigger")(function* <
      Name extends TriggerName,
      Input = Parameters<Required<Hooks>[Name]>[0],
      Output = Parameters<Required<Hooks>[Name]>[1],
    >(name: Name, input: Input, output: Output) {
      if (!name) return output
      const s = yield* InstanceState.get(state)
      const listening = s.hooks.filter((hook) => hook[name])
      if (!listening.length) return output
      const sessionID = (input as { sessionID?: unknown }).sessionID
      const defined = typeof sessionID === "string" ? Harness.ofSession(sessionID) : Harness.definition(Harness.DEFAULT)
      // mango-code: the conversation of a `commands` harness sends its own prompt, tools and messages: no plugin adds to them
      if (typeof sessionID === "string" && defined.kind === "commands" && ADDING_HOOKS.has(name)) return output
      // mango-code: a plugin with a name reads the harness of the conversation: which hooks are on (its own and the
      // switches of the settings page), their numbers and texts. The settings are re-read at every round, only when such
      // a plugin listens: a change applies at once.
      let imp: PromptSettings.Valid | undefined
      for (const hook of listening) {
        const fn = hook[name] as any
        const pluginName = names.get(hook)
        if (!pluginName) {
          yield* Effect.promise(async () => fn(input, output))
          continue
        }
        if (!imp) {
          const loaded = PromptSettings.load((yield* InstanceState.context).directory, defined.id)
          imp = loaded
          if (typeof sessionID === "string")
            Object.assign(input as object, { harness: Harness.withSwitches(defined, (hook) => PromptSettings.chosen(loaded, "hooks", hook)) })
        }
        // mango-code: a plugin that is switched off does not run
        if (!PromptSettings.enabled(imp, "plugins", pluginName)) continue
        const lengthBefore = addedLength(name, output)
        yield* Effect.promise(async () => fn(input, output))
        collectAdditions(name, pluginName, input, output, lengthBefore, imp)
      }
      return output
    })

    const list = Effect.fn("Plugin.list")(function* () {
      const s = yield* InstanceState.get(state)
      return s.hooks
    })

    const init = Effect.fn("Plugin.init")(function* () {
      yield* InstanceState.get(state)
    })

    return Service.of({ trigger, list, init })
  }),
)

// mango-code: two hooks add text to the prompt. `experimental.chat.system.transform` appends to the system prompt
// (also the instruction files of an app's extra folders): those of a file that is switched off are removed here,
// right after the plugin added them. `chat.message` adds parts to the user's message (the reminder): its text is
// remembered, because it is part of the plugin's weight that the first request measures.
const SYSTEM_HOOK = "experimental.chat.system.transform"
const MESSAGE_HOOK = "chat.message"
// mango-code: the hooks through which a plugin puts text into what the model reads
const ADDING_HOOKS = new Set<string>([
  SYSTEM_HOOK,
  MESSAGE_HOOK,
  "experimental.chat.messages.transform",
  "tool.execute.before",
  "tool.execute.after",
])

/** How many system texts / message parts there are before the plugin runs; -1 for hooks that add nothing. */
function addedLength(name: string, output: any): number {
  if (name === SYSTEM_HOOK) return output.system.length
  if (name === MESSAGE_HOOK) return output.parts.length
  return -1
}

function collectAdditions(
  name: string,
  plugin: string,
  input: any,
  output: any,
  lengthBefore: number,
  imp: PromptSettings.Valid,
) {
  if (lengthBefore < 0) return
  if (name === MESSAGE_HOOK) {
    const parts = (output.parts as { type: string; text?: string }[]).slice(lengthBefore)
    PromptMeasurement.recordPlugin(
      input?.sessionID,
      plugin,
      parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])),
    )
    return
  }
  for (const text of (output.system as string[]).splice(lengthBefore)) {
    const file = PromptSettings.instructionsFile(text)
    if (file && !PromptSettings.enabled(imp, "instructions", file)) continue
    output.system.push(text)
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, Config.node, RuntimeFlags.node],
})

export * as Plugin from "."
