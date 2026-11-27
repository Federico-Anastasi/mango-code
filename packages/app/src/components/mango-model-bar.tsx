// mango-code: the model in the top bar, from every screen: its name and what it is doing (loading with its seconds, a
// download, the engine the app came with), and its menu. At the first start, before any model, the language of the
// interface is there instead. Choosing a model uses it now: the load in progress stops
// (`POST /mango/model/use`). The menu lists the models on the computer, says which one is in use and which is the
// default, then the downloads on their way («In arrivo: …», each leading to its row in Models), and ends with «Manage
// models…», which opens the settings on Models. The menu under the composer lists the same models
// (dialog-select-model.tsx).
import { createMemo, createSignal, For, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { useProviders } from "@/hooks/use-providers"
import { isServerProvider } from "@/utils/model-info"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { showToast } from "@/utils/toast"
import { matchesModelSearch } from "./dialog-select-model-search"
import { failureText } from "@/context/mango"
import { comingDownload, homeView, type Download, type MangoState } from "@/utils/mango-state"
import { LanguagePicker } from "./mango-home"
import { downloadPercent, whereLine } from "./mango-text"
import { arrivingRows } from "./settings-page/lines"

type Translate = ReturnType<typeof useLanguage>["t"]

/**
 * What the bar says: the model and, while it is not simply ready, what it is doing (`status`). They are drawn apart so
 * that in a narrow window the name gives way and the state (a percentage, the seconds) stays seen.
 */
export function barParts(state: MangoState, t: Translate): { name: string; status?: string } {
  // the model of new conversations is a server's: the bar names it, as the Home and the menu under the chat do, also
  // while a local model stays loaded for the conversations that use it
  if (state.server_model && state.model.phase !== "remote") return { name: state.server_label ?? state.server_model }
  return engineParts(state, t)
}

/** What the engine of this PC is doing, by its model; a server's model of new conversations when it has none. */
function engineParts(state: MangoState, t: Translate): { name: string; status?: string } {
  const model = state.model
  switch (model.phase) {
    case "ready":
      return { name: model.label }
    case "loading":
      return { name: model.label, status: t("mango.bar.status.loading", { seconds: model.seconds }) }
    case "lent":
      return { name: model.label, status: t("mango.bar.status.lent") }
    case "remote":
      return { name: t("mango.bar.remote") }
  }
  if (state.server_model) return { name: state.server_label ?? state.server_model }
  const download = barDownload(state)
  if (download?.engine_only) return { name: t("mango.engine.updating"), status: `${downloadPercent(download)}%` }
  if (download)
    return { name: download.label, status: t("mango.bar.status.downloading", { percent: downloadPercent(download) }) }
  // a start or a download that failed too: the line above the box and the Home say why
  return { name: t("mango.bar.none") }
}

/**
 * What the button under the composer says for a model of this PC: the same words as the bar, the load without its
 * seconds. With no model on the computer the agent still offers its catalog: this keeps the button from
 * naming a model that is neither there nor coming.
 */
export function composerParts(state: MangoState, t: Translate) {
  if (state.model.phase === "loading") return { name: state.model.label, status: t("mango.composer.status.loading") }
  return engineParts(state, t)
}

/**
 * A model's name and what it is doing, on one line: the name is cut first, and a cut name shows whole under the pointer.
 * Whole, it has no title of its own, and the button's (the bar's «change it here») stays.
 */
export function ModelLabel(props: { name: string; status?: string; class?: string }) {
  return (
    <span class={`flex min-w-0 ${props.class ?? ""}`}>
      <span
        class="truncate"
        onMouseEnter={(event) => {
          const name = event.currentTarget
          if (name.scrollWidth > name.clientWidth) name.title = props.name
          else name.removeAttribute("title")
        }}
      >
        {props.name}
      </span>
      <Show when={props.status}>{(status) => <span class="shrink-0 whitespace-pre">{` · ${status()}`}</span>}</Show>
    </span>
  )
}

/**
 * The colour of the dot beside the model in the bar: ready is green, a load or a download on its way is amber, a model
 * that did not start is red, and anything off (nothing chosen, the cards lent away, a remote engine out of reach) is grey.
 */
export function barTone(state: MangoState): "ready" | "progress" | "error" | "off" {
  const model = state.model
  if (state.server_model && model.phase !== "remote") return "ready"
  if (model.phase === "ready") return "ready"
  if (model.phase === "loading") return "progress"
  if (model.phase === "failed") return "error"
  if (model.phase === "remote") return model.reachable ? "ready" : "off"
  if (model.phase === "none" && barDownload(state)) return "progress"
  return "off"
}

/**
 * What the dot says to those who do not see it, where the visible words do not say it already: a model that did not
 * start (the bar then reads «no model in use») and a model that is ready.
 */
export function barDescription(state: MangoState, t: Translate) {
  if (state.model.phase === "failed") return t("mango.failed.title", { model: state.model.label })
  if (barTone(state) === "ready") return t("mango.menu.inUse")
}

/** The download the bar names when no model is in use and one is coming: its label leads to its row in Models. */
export function barDownload(state: MangoState) {
  if (state.server_model) return
  const download = comingDownload(state)
  if (download && download.total > 0) return download
}

/** The tag of a model in the menu: in use, the default, loading. */
export function modelTag(key: string, state: MangoState, t: Translate) {
  const model = state.model
  const loading = model.phase === "loading" && model.model === key
  const inUse = model.phase === "ready" && model.model === key
  const tags = [
    state.default_model === key && !state.server_model ? t("mango.menu.default") : undefined,
    inUse ? t("mango.menu.inUse") : undefined,
    loading ? t("mango.menu.loading") : undefined,
  ].filter(Boolean)
  return tags.length ? tags.join(" · ") : undefined
}

/**
 * A download in the menu, under the models: «In arrivo: Qwen» with how far it is, or that it waits its turn, is paused
 * or did not succeed. With a model in use the bar names only that model: the menu is where the downloads show.
 */
export function arrivingParts(download: Download, t: Translate) {
  return {
    name: download.engine_only ? t("mango.engine.updating") : t("mango.menu.arriving", { model: download.label }),
    status:
      download.state === "active"
        ? `${downloadPercent(download)}%`
        : t(
            download.state === "waiting"
              ? "settings.models.download.waiting"
              : download.state === "paused"
                ? "settings.models.download.paused"
                : "mango.menu.arriving.failed",
          ),
  }
}

export function MangoModelBar() {
  const mango = useMango()
  const language = useLanguage()
  const providers = useProviders(() => undefined)
  const [open, setOpen] = createSignal(false)
  const [search, setSearch] = createSignal("")
  const present = createMemo(() =>
    (mango.catalog() ?? []).filter((m) => m.present && matchesModelSearch(search(), [m.label, m.key])),
  )
  // the models of the external servers, one group each by the server's name: the same ones the menu under the chat lists
  const allServers = createMemo(() =>
    providers
      .connected()
      .filter((p) => isServerProvider(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        models: Object.values(p.models).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const servers = createMemo(() =>
    allServers()
      .map((group) => ({
        ...group,
        models: group.models.filter((m) => matchesModelSearch(search(), [m.name, m.id, group.name])),
      }))
      .filter((group) => group.models.length > 0),
  )
  // only a model ready or on its way is «in use»: one that failed or lent its cards is not
  const current = () => {
    const model = mango.state()?.model
    return model?.phase === "ready" || model?.phase === "loading" ? model.model : undefined
  }
  const serverCurrent = () => (current() === undefined ? (mango.state()?.server_model ?? undefined) : undefined)
  const chooseServer = (server: string, model: string) => {
    setOpen(false)
    void Promise.resolve(mango.bridge()?.servers?.setDefault(server, model))
      .then(() => mango.refresh())
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("mango.use.failed"),
          description: mangoDesktopError(error).message,
        }),
      )
  }
  const choose = (key: string) => {
    setOpen(false)
    void mango.use(key).catch((error: unknown) =>
      showToast({
        variant: "error",
        title: language.t("mango.use.failed"),
        description: failureText(error, language.t),
      }),
    )
  }
  const toggle = (next: boolean) => {
    const state = mango.state()
    const download = next && state ? barDownload(state) : undefined
    if (download) return mango.openModelRow(download.model)
    setOpen(next)
    if (next) void mango.refresh()
    else setSearch("")
  }
  const manage = () => {
    setOpen(false)
    mango.openModels()
  }
  const openRow = (model: string) => {
    setOpen(false)
    mango.openModelRow(model)
  }

  return (
    <Show
      when={homeView(mango.state(), mango.catalog(), mango.catalogFailed()) !== "welcome"}
      fallback={<LanguagePicker />}
    >
      <Show when={mango.state()}>
        {(state) => (
          <MenuV2 open={open()} modal={false} placement="bottom-end" gutter={6} onOpenChange={toggle}>
            <MenuV2.Trigger
              as={ButtonV2}
              variant="ghost-muted"
              size="large"
              class="min-w-0 max-w-[320px] shrink justify-start ![font-weight:400]"
              data-action="titlebar-model"
              data-phase={state().model.phase}
              aria-description={barDescription(state(), language.t)}
              title={state().model.phase === "remote" ? undefined : language.t("mango.bar.tooltip")}
              disabled={state().model.phase === "remote"}
            >
              <ModelLabel {...barParts(state(), language.t)} />
              <span data-slot="state-dot" data-tone={barTone(state())} aria-hidden="true" />
              <Show when={state().model.phase !== "remote"}>
                <Icon name="chevron-down" />
              </Show>
            </MenuV2.Trigger>
            <MenuV2.Portal>
              <MenuV2.Content
                data-component="mango-model-menu"
                class="w-[min(430px,calc(100vw-24px))] overflow-hidden !p-0.5 focus:outline-none"
              >
                <Show
                  when={present().length > 0 || servers().length > 0 || search().trim()}
                  fallback={
                    <div class="flex h-10 items-center px-3 text-[13px] text-v2-text-text-faint">
                      {language.t(
                        mango.catalog() !== undefined
                          ? "mango.menu.empty"
                          : mango.catalogFailed()
                            ? "mango.models.unreadable"
                            : "mango.menu.reading",
                      )}
                    </div>
                  }
                >
                  <Show when={allServers().length > 0}>
                    <div class="flex h-7 items-center gap-2 pl-3 pr-2.5 text-v2-icon-icon-muted">
                      <Icon name="magnifying-glass" size="small" class="shrink-0" />
                      <input
                        value={search()}
                        placeholder={language.t("dialog.model.search.placeholder")}
                        aria-label={language.t("dialog.model.search.placeholder")}
                        data-slot="mango-model-search"
                        class="h-7 min-w-0 flex-1 border-0 bg-transparent text-[13px] font-normal leading-5 text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint"
                        spellcheck={false}
                        autocomplete="off"
                        onInput={(event) => setSearch(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key.length === 1 ||
                            ["Backspace", "Delete", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)
                          )
                            event.stopPropagation()
                        }}
                      />
                    </div>
                    <div class="h-px bg-v2-border-border-muted" />
                  </Show>
                  <ScrollView data-slot="model-selector-scroll" class="max-h-[340px] min-h-0">
                    <Show when={present().length === 0 && servers().length === 0}>
                      <div class="flex h-10 items-center px-3 text-[13px] text-v2-text-text-faint">
                        {language.t("dialog.model.empty")}
                      </div>
                    </Show>
                    <MenuV2.Group>
                      <Show when={servers().length > 0 && present().length > 0}>
                        <MenuV2.GroupLabel class="sticky top-0 z-10 gap-2 bg-v2-background-bg-layer-01 px-3">
                          <span class="min-w-0 truncate">{language.t("mango.menu.thisPc")}</span>
                        </MenuV2.GroupLabel>
                      </Show>
                      <MenuV2.RadioGroup value={current()}>
                        <For each={present()}>
                          {(model) => (
                            <MenuV2.RadioItem
                              value={model.key}
                              data-option-key={model.key}
                              class="w-full !h-auto min-h-7 !py-2"
                              onSelect={() => choose(model.key)}
                            >
                              <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span class="min-w-0 truncate leading-5">{model.label}</span>
                                <Show when={whereLine(model.verdict.where, language)}>
                                  {(line) => (
                                    <span
                                      data-slot="model-detail"
                                      class="truncate text-[12px] leading-4 text-v2-text-text-faint"
                                    >
                                      {line()}
                                    </span>
                                  )}
                                </Show>
                              </span>
                              <Show when={modelTag(model.key, state(), language.t)}>
                                {(tag) => (
                                  <span
                                    data-slot="model-tag"
                                    class="shrink-0 text-[12px] leading-4 text-v2-text-text-muted"
                                  >
                                    {tag()}
                                  </span>
                                )}
                              </Show>
                            </MenuV2.RadioItem>
                          )}
                        </For>
                      </MenuV2.RadioGroup>
                    </MenuV2.Group>
                    <For each={servers()}>
                      {(group) => (
                        <MenuV2.Group>
                          <MenuV2.GroupLabel class="sticky top-0 z-10 gap-2 bg-v2-background-bg-layer-01 px-3">
                            <span class="min-w-0 truncate">{group.name}</span>
                          </MenuV2.GroupLabel>
                          <MenuV2.RadioGroup value={serverCurrent()}>
                            <For each={group.models}>
                              {(model) => (
                                <MenuV2.RadioItem
                                  value={`${group.id}/${model.id}`}
                                  data-option-key={`${group.id}:${model.id}`}
                                  class="w-full !h-auto min-h-7 !py-2"
                                  onSelect={() => chooseServer(group.id, model.id)}
                                >
                                  <span class="min-w-0 flex-1 truncate leading-5">{model.name}</span>
                                  <Show when={mango.state()?.server_model === `${group.id}/${model.id}`}>
                                    <span
                                      data-slot="model-tag"
                                      class="shrink-0 text-[12px] leading-4 text-v2-text-text-muted"
                                    >
                                      {language.t("mango.menu.default")}
                                    </span>
                                  </Show>
                                </MenuV2.RadioItem>
                              )}
                            </For>
                          </MenuV2.RadioGroup>
                        </MenuV2.Group>
                      )}
                    </For>
                  </ScrollView>
                </Show>
                <For each={arrivingRows(state().downloads)}>
                  {(download) => (
                    <MenuV2.Item
                      data-action="mango-arriving"
                      data-option-key={download.model}
                      onSelect={() => openRow(download.model)}
                    >
                      <span class="min-w-0 flex-1 truncate leading-5">{arrivingParts(download, language.t).name}</span>
                      <span data-slot="model-tag" class="shrink-0 text-[12px] leading-4 text-v2-text-text-muted">
                        {arrivingParts(download, language.t).status}
                      </span>
                    </MenuV2.Item>
                  )}
                </For>
                <div class="my-0.5 h-px bg-v2-border-border-muted" />
                <MenuV2.Item data-action="mango-manage-models" onSelect={manage}>
                  <Icon name="outline-sliders" size="small" />
                  <span class="min-w-0 flex-1 truncate leading-5">{language.t("mango.menu.manage")}</span>
                </MenuV2.Item>
              </MenuV2.Content>
            </MenuV2.Portal>
          </MenuV2>
        )}
      </Show>
    </Show>
  )
}
