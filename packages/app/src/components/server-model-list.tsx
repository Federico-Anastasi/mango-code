// mango-code: the models of a server to choose from, as the user meets them in the Home and in the server's card: a search
// (when the list is long) and each model with its price when the service says it. Nothing is chosen until the user picks a
// row; «Not the default» is a row of its own where the caller lets the choice be undone.
import { createSignal, For, Show } from "solid-js"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import type { MangoServerModel } from "@/utils/mango-desktop"
import { serverPrice } from "@/utils/mango-server-price"

const row =
  "flex w-full flex-col items-start rounded-[7px] px-3 py-2 text-left hover:bg-v2-overlay-simple-overlay-hover"
const note = "text-[13px] leading-5 text-v2-text-text-muted"

export function ServerModelList(props: {
  models: MangoServerModel[]
  /** The model that is the choice now. */
  current?: string
  search: boolean
  disabled?: boolean
  onPick: (model: string) => void
  onClear?: () => void
}) {
  const language = useLanguage()
  const [search, setSearch] = createSignal("")
  const shown = () => {
    const words = search().toLowerCase().split(/\s+/).filter(Boolean)
    return props.models.filter((model) =>
      words.every((word) => `${model.label} ${model.id}`.toLowerCase().includes(word)),
    )
  }
  const priceText = (model: MangoServerModel) => {
    const price = serverPrice(model.price, language.intl())
    if (!price) return
    if (price.kind === "free") return language.t("mango.price.free")
    return language.t("mango.price.perMillion", { input: price.input, output: price.output })
  }
  return (
    <div data-component="server-model-list" class="flex flex-col gap-3">
      <Show when={props.search}>
        <TextInputV2
          value={search()}
          aria-label={language.t("mango.home.serverChoice.search")}
          placeholder={language.t("mango.home.serverChoice.search")}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      </Show>
      <div class="flex max-h-[360px] flex-col gap-0.5 overflow-y-auto">
        <Show when={props.onClear && !search().trim()}>
          <button
            type="button"
            data-action="mango-server-model-none"
            class={row}
            aria-current={props.current === undefined ? "true" : undefined}
            disabled={props.disabled}
            onClick={() => props.onClear?.()}
          >
            <span class="text-[14px] leading-5 text-v2-text-text-base">
              {language.t("settings.links.servers.notDefault")}
            </span>
          </button>
        </Show>
        <For each={shown()} fallback={<p class={note}>{language.t("mango.home.serverChoice.none")}</p>}>
          {(model) => (
            <button
              type="button"
              data-action="mango-server-model"
              data-model={model.id}
              class={row}
              aria-current={props.current === model.id ? "true" : undefined}
              disabled={props.disabled}
              onClick={() => props.onPick(model.id)}
            >
              <span
                class="text-[14px] leading-5 text-v2-text-text-base"
                classList={{ "[font-weight:600]": props.current === model.id }}
              >
                {model.label}
              </span>
              <Show when={priceText(model)}>{(text) => <span class={note}>{text()}</span>}</Show>
            </button>
          )}
        </For>
      </div>
    </div>
  )
}
