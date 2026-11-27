// mango-code: Settings › Models › «Another model»: a model from Hugging Face (a name to search, or a link) or a GGUF
// already on the computer. Before adding it the app says how it would run here: each quantization with its weight, where
// it runs and its context, the one it proposes chosen, and «estimated memory» for a kind of model it does not know yet.
// Added, it is in the models list, to download or ready.
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { type Component, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useOpenSettings } from "./open"
import { sizeTiers, variantFit, variantLine } from "./lines"
import {
  mangoDesktopError,
  type MangoAnalysis,
  type MangoDesktopError,
  type MangoOtherFound,
  type MangoSearchResult,
} from "@/utils/mango-desktop"

const SIZE_LABELS = {
  small: "settings.models.other.size.small",
  medium: "settings.models.other.size.medium",
  large: "settings.models.other.size.large",
} as const

/** `reveal`: opens a model's row of the list and brings it into view; `hasRow`: the list has one for that model. */
export const OtherModel: Component<{
  onAdded: () => void
  hasRow: (key: string) => boolean
  reveal: (key: string) => void
}> = (props) => {
  const language = useLanguage()
  const openSettings = useOpenSettings()
  const other = () => window.__MANGO_DESKTOP__?.otherModels
  const [text, setText] = createSignal("")
  const [found, setFound] = createStore<{
    results?: MangoSearchResult[]
    analysis?: MangoAnalysis
    picked?: number
    images: boolean
    busy?: string
    error?: MangoDesktopError
    added?: string
    /** The repo of a model of the catalog: the line leads to its row instead of an analysis. */
    tested?: { key: string; label: string }
  }>({ images: false })

  /** A job with its sentence while it runs, and the refusal under the box if it fails. */
  async function work(busy: string, job: () => Promise<void>) {
    setFound({ busy, error: undefined, added: undefined, tested: undefined })
    try {
      await job()
    } catch (cause) {
      setFound("error", mangoDesktopError(cause))
    } finally {
      setFound("busy", undefined)
    }
  }

  const show = (analysis: MangoAnalysis) =>
    setFound({
      results: undefined,
      analysis,
      images: false,
      picked: Math.max(
        0,
        analysis.variants.findIndex((v) => v.recommended && v.placement),
      ),
    })

  const take = (answer: MangoOtherFound) => {
    if (answer.type === "analysis") return show(answer.analysis)
    if (answer.type === "tested")
      return setFound({ analysis: undefined, results: undefined, tested: { key: answer.key, label: answer.label } })
    setFound({ analysis: undefined, results: answer.results })
  }

  /** A name, a link, or a result's id. */
  const search = (value: string) =>
    work(language.t("settings.models.other.searching"), async () => {
      const api = other()
      if (!value || !api) return
      take(await api.search(value))
    })

  const pickFile = () =>
    work(language.t("settings.models.other.reading"), async () => {
      const api = other()
      const file = await api?.pickFile()
      if (!api || !file) return
      show(await api.analyze({ file }))
    })

  const add = () =>
    work(language.t("settings.models.other.adding"), async () => {
      const analysis = found.analysis
      const variant = analysis?.variants[found.picked ?? -1]
      if (!analysis || !variant) return
      await other()?.add({ key: variant.key, entry: variantFit(variant, found.images).entry })
      setFound({ analysis: undefined, added: analysis.name })
      props.onAdded()
    })

  /** A quantization by its size name when the sizes tell them apart, else by its own name; «consigliato» marks the proposed one. */
  const variantLabel = (variant: MangoAnalysis["variants"][number], index: number) => {
    const name = tiers() ? language.t(SIZE_LABELS[tiers()![index]]) : variant.name
    return variant.recommended ? `${name} · ${language.t("settings.models.recommended")}` : name
  }
  const tiers = () => sizeTiers(found.analysis?.variants.map((variant) => variant.bytes) ?? [])
  const imagesExtra = () =>
    Math.max(0, ...(found.analysis?.variants.map((v) => (v.with_images ? v.with_images.bytes - v.bytes : 0)) ?? [0]))
  /** The link to the token, under a refusal that the token answers (`code` `"token"`; the sentence says what to do). */
  const tokenLink = () => (
    <button
      type="button"
      class="settings-page-link"
      onClick={() => openSettings("links", language.t("settings.token.title"))}
    >
      {language.t("settings.token.title")}
    </button>
  )

  return (
    <div class="settings-page-box" data-component="settings-other-model">
      <form
        class="settings-page-row"
        onSubmit={(event) => {
          event.preventDefault()
          void search(text().trim())
        }}
      >
        <div class="settings-page-row-copy" data-action="settings-other-model-search">
          <TextInputV2
            type="text"
            appearance="base"
            value={text()}
            onInput={(event) => setText(event.currentTarget.value)}
            placeholder={language.t("settings.models.other.placeholder")}
            aria-label={language.t("settings.models.other.placeholder")}
            disabled={!other()}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <div class="settings-page-row-meta">
          <ButtonV2 type="submit" variant="neutral" disabled={!other() || !!found.busy || !text().trim()}>
            {language.t("settings.models.other.search")}
          </ButtonV2>
          <ButtonV2
            type="button"
            variant="ghost"
            disabled={!other() || !!found.busy}
            onClick={() => void pickFile()}
            data-action="settings-other-model-file"
          >
            {language.t("settings.models.other.file")}
          </ButtonV2>
        </div>
      </form>
      <div class="settings-page-row">
        <span class="settings-page-row-line" data-slot="settings-other-model-line">
          {found.busy ??
            found.error?.message ??
            (found.tested
              ? language.t("settings.models.other.tested", { name: found.tested.label })
              : found.added
                ? language.t("settings.models.other.added", { name: found.added })
                : language.t("settings.models.other.description"))}
          <Show when={!found.busy && found.error?.code === "token"}> {tokenLink()}</Show>
          <Show
            when={
              !found.busy && !found.error && found.tested && props.hasRow(found.tested.key) ? found.tested : undefined
            }
          >
            {(tested) => (
              <>
                {" "}
                <button
                  type="button"
                  class="settings-page-link"
                  data-action="settings-other-model-tested"
                  onClick={() => props.reveal(tested().key)}
                >
                  {language.t("settings.models.other.testedGo")}
                </button>
              </>
            )}
          </Show>
        </span>
      </div>

      <Show when={found.results}>
        {(results) => (
          <Show
            when={results().length}
            fallback={
              <div class="settings-page-row settings-page-row-line">{language.t("settings.models.other.none")}</div>
            }
          >
            <For each={results()}>
              {(result) => (
                <button
                  type="button"
                  class="settings-page-row settings-page-row--click"
                  onClick={() => void search(result.id)}
                  data-other-result={result.id}
                >
                  <span class="settings-page-row-copy">
                    <span data-slot="settings-v2-row-title">{result.id}</span>
                    <span class="settings-page-row-line">
                      {language.t("settings.models.other.popularity", {
                        downloads: result.downloads.toLocaleString(language.locale()),
                        likes: result.likes.toLocaleString(language.locale()),
                      })}
                    </span>
                  </span>
                  <Show when={result.gated}>
                    <Tag>{language.t("settings.models.other.gated")}</Tag>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        )}
      </Show>

      <Show when={found.analysis}>
        {(analysis) => (
          <div class="settings-page-detail" data-slot="settings-other-analysis">
            <div class="settings-page-field">
              <b>
                {analysis().name}
                <Show when={analysis().estimated}>
                  {" "}
                  <Tag data-slot="settings-other-estimated">{language.t("settings.models.estimated")}</Tag>
                </Show>
              </b>
              <Show when={analysis().gated}>
                <small>
                  {language.t("settings.models.other.gatedNote")} {tokenLink()}
                </small>
              </Show>
              <For each={analysis().warnings}>
                {(warning) => <small data-tone={warning.severe ? "danger" : undefined}>{warning.text}</small>}
              </For>
            </div>
            <div class="settings-page-field" data-slot="settings-other-variants">
              <Show
                when={analysis().variants.length <= 4}
                fallback={
                  <SelectV2
                    appearance="inline"
                    options={analysis().variants.map((variant, index) => ({
                      index,
                      label: variantLabel(variant, index),
                    }))}
                    current={{
                      index: found.picked ?? 0,
                      label: variantLabel(analysis().variants[found.picked ?? 0], found.picked ?? 0),
                    }}
                    value={(option) => String(option.index)}
                    label={(option) => option.label}
                    onSelect={(option) => option && setFound("picked", option.index)}
                    aria-label={analysis().name}
                  />
                }
              >
                <SegmentedControlV2
                  value={String(found.picked ?? "")}
                  onChange={(value) => value && setFound("picked", Number(value))}
                  aria-label={analysis().name}
                >
                  <For each={analysis().variants}>
                    {(variant, index) => (
                      <SegmentedControlItemV2
                        value={String(index())}
                        disabled={!variantFit(variant, found.images).placement}
                      >
                        {variantLabel(variant, index())}
                      </SegmentedControlItemV2>
                    )}
                  </For>
                </SegmentedControlV2>
              </Show>
              <For each={analysis().variants}>
                {(variant, index) => (
                  <small data-picked={found.picked === index() ? "" : undefined}>
                    {variantLabel(variant, index())}:{" "}
                    {variantLine(variant, found.images, !!tiers(), language, language.locale())}
                  </small>
                )}
              </For>
            </div>
            <Show when={imagesExtra() > 0}>
              <div class="settings-page-field">
                <Switch checked={found.images} onChange={(checked) => setFound("images", checked)}>
                  {language.t("settings.models.other.images", {
                    size: formatFileSize(imagesExtra(), language.locale()),
                  })}
                </Switch>
              </div>
            </Show>
            <div class="settings-page-actions">
              <ButtonV2
                variant="neutral"
                disabled={
                  !!found.busy ||
                  !analysis().variants[found.picked ?? -1] ||
                  !variantFit(analysis().variants[found.picked ?? -1], found.images).placement
                }
                onClick={() => void add()}
                data-action="settings-other-model-add"
              >
                {language.t("settings.models.other.add")}
              </ButtonV2>
              <ButtonV2 variant="ghost" onClick={() => setFound("analysis", undefined)}>
                {language.t("common.cancel")}
              </ButtonV2>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}
