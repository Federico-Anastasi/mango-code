import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    // mango-code: the keys `{env:…}` put in the providers stay in the agent; whoever reads the config gets it without them.
    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      const config = yield* configSvc.get()
      if (!config.provider) return config
      const provider = Object.fromEntries(
        Object.entries(config.provider).map(([id, item]) => {
          if (!item.options) return [id, item]
          const { apiKey: _, ...options } = item.options
          return [id, { ...item, options }]
        }),
      )
      return { ...config, provider }
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toClientInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)
