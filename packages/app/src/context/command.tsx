import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

export interface CommandOption {
  id: string
  title: string
  description?: string
  slash?: string
  disabled?: boolean
  onSelect?: (source?: CommandSource) => void
}

type CommandSource = "slash"

export type CommandRegistration = {
  key?: string
  options: Accessor<CommandOption[]>
}

export function addCommandRegistration(registrations: CommandRegistration[], entry: CommandRegistration) {
  return [entry, ...registrations]
}

export function activeCommandRegistrations(registrations: CommandRegistration[]) {
  const keys = new Set<string>()
  return registrations.filter((entry) => {
    if (entry.key === undefined) return true
    if (keys.has(entry.key)) return false
    keys.add(entry.key)
    return true
  })
}

export const { use: useCommand, provider: CommandProvider } = createSimpleContext({
  name: "Command",
  init: () => {
    const [store, setStore] = createStore({
      registrations: [] as CommandRegistration[],
    })
    const warnedDuplicates = new Set<string>()

    const options = createMemo(() => {
      const seen = new Set<string>()
      const all: CommandOption[] = []

      for (const reg of activeCommandRegistrations(store.registrations)) {
        for (const opt of reg.options()) {
          if (seen.has(opt.id)) {
            if (import.meta.env.DEV && !warnedDuplicates.has(opt.id)) {
              warnedDuplicates.add(opt.id)
              console.warn(`[command] duplicate command id "${opt.id}" registered; keeping first entry`)
            }
            continue
          }
          seen.add(opt.id)
          all.push(opt)
        }
      }

      return all
    })

    function register(cb: () => CommandOption[]): void
    function register(key: string, cb: () => CommandOption[]): void
    function register(key: string | (() => CommandOption[]), cb?: () => CommandOption[]) {
      const id = typeof key === "string" ? key : undefined
      const next = typeof key === "function" ? key : cb
      if (!next) return
      const entry: CommandRegistration = {
        key: id,
        options: createMemo(next),
      }
      setStore("registrations", (arr) => addCommandRegistration(arr, entry))
      onCleanup(() => {
        setStore("registrations", (arr) => arr.filter((x) => x !== entry))
      })
    }

    return {
      register,
      trigger(id: string, source?: CommandSource) {
        options()
          .find((option) => option.id === id)
          ?.onSelect?.(source)
      },
      get options() {
        return options()
      },
    }
  },
})
