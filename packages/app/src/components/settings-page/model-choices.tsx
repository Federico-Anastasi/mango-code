// mango-code: Settings › Models, the two choices of a model that are numbers: the context (the steps offered, and
// «Custom» for any number of tokens) and the style of the answers (three shortcuts and the six values they fill).
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { contextLabel, SAMPLING_KEYS, type CatalogEntry, type Sampling } from "@/utils/mango-state"
import type { MangoModelChoices } from "@/utils/mango-desktop"
import {
  contextIssue,
  parseContext,
  parseSamplingValue,
  SAMPLING_RANGES,
  samplingIssue,
  samplingText,
  stepContext,
} from "./lines"
import { createHarnessList } from "./harnesses"
import { useOpenSettings } from "./open"

const STYLES = {
  recommended: { label: "settings.models.style.recommended", line: "settings.models.style.recommended.description" },
  precise: { label: "settings.models.style.precise", line: "settings.models.style.precise.description" },
  creative: { label: "settings.models.style.creative", line: "settings.models.style.creative.description" },
} as const
const SAMPLING = {
  temperature: "settings.models.sampling.temperature",
  top_p: "settings.models.sampling.top_p",
  top_k: "settings.models.sampling.top_k",
  min_p: "settings.models.sampling.min_p",
  presence_penalty: "settings.models.sampling.presence_penalty",
  repeat_penalty: "settings.models.sampling.repeat_penalty",
} as const

type FieldProps = {
  model: CatalogEntry
  disabled: boolean
  choose: (patch: Partial<MangoModelChoices>) => unknown
}

/**
 * The steps the computer offers up to the largest that fits, and «Custom»: the plus and the minus in steps of 4096
 * tokens, or the number typed, from the smallest step to the largest. A choice the computer cannot carry (a larger
 * computer's, kept) is shown as it was chosen, with what the model starts with.
 */
export const ContextField: Component<FieldProps> = (props) => (
  // A model that fits nowhere with the cards in use offers no context: nothing to show, and no number to start from.
  <Show when={props.model.limits.context.length}>
    <ContextSteps {...props} />
  </Show>
)

const ContextSteps: Component<FieldProps> = (props) => {
  const language = useLanguage()
  const steps = () => props.model.limits.context
  const min = () => steps()[0]
  const max = () => steps().at(-1) ?? min()
  const chosen = () => props.model.choices.context
  const current = () => chosen() ?? max()
  const format = (tokens: number) => tokens.toLocaleString(language.locale())
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal(format(current()))
  const [issue, setIssue] = createSignal<"min" | "max">()
  createEffect(on(current, (tokens) => setText(format(tokens))))
  const custom = () => open() || (chosen() !== null && !steps().includes(chosen()!))
  const started = () => props.model.verdict.where?.context

  const set = (tokens: number) => {
    setIssue(undefined)
    if (tokens !== current()) void props.choose({ context: tokens })
  }
  const commit = () => {
    const tokens = parseContext(text())
    if (tokens === undefined) return setText(format(current()))
    const bad = contextIssue(tokens, min(), max())
    setIssue(bad)
    if (!bad) set(tokens)
  }

  return (
    <div class="settings-page-field">
      <b data-slot="settings-field-title">{language.t("settings.models.context.title")}</b>
      <SegmentedControlV2
        value={custom() ? "custom" : String(current())}
        disabled={props.disabled}
        onChange={(value) => {
          if (!value) return
          if (value === "custom") return setOpen(true)
          setOpen(false)
          setIssue(undefined)
          // the largest offered is «as much as fits»: it follows the choices that change it
          const tokens = Number(value)
          void props.choose({ context: tokens === max() ? null : tokens })
        }}
        data-action="settings-model-context"
        aria-label={language.t("settings.models.context.title")}
      >
        <For each={steps()}>
          {(tokens) => <SegmentedControlItemV2 value={String(tokens)}>{contextLabel(tokens)}</SegmentedControlItemV2>}
        </For>
        <Show when={max() > min() || custom()}>
          <SegmentedControlItemV2 value="custom">{language.t("settings.models.context.custom")}</SegmentedControlItemV2>
        </Show>
      </SegmentedControlV2>
      <Show when={custom()}>
        <div class="settings-page-context-custom" data-slot="settings-model-context-custom">
          <ButtonV2
            variant="neutral"
            disabled={props.disabled || current() <= min()}
            onClick={() => set(stepContext(current(), -1, min(), max()))}
            aria-label={language.t("settings.models.context.less")}
            data-action="settings-model-context-less"
          >
            −
          </ButtonV2>
          <TextInputV2
            numeric
            appearance="base"
            value={text()}
            invalid={!!issue()}
            disabled={props.disabled}
            onInput={(event) => setText(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
            inputmode="numeric"
            spellcheck={false}
            autocomplete="off"
            aria-label={language.t("settings.models.context.value")}
            data-action="settings-model-context-value"
          />
          <ButtonV2
            variant="neutral"
            disabled={props.disabled || current() >= max()}
            onClick={() => set(stepContext(current(), 1, min(), max()))}
            aria-label={language.t("settings.models.context.more")}
            data-action="settings-model-context-more"
          >
            +
          </ButtonV2>
          <span>
            {language.t("settings.models.context.range", { min: contextLabel(min()), max: contextLabel(max()) })}
          </span>
        </div>
      </Show>
      <small data-tone={issue() ? "danger" : undefined} data-slot="settings-model-context-note">
        {issue() === "min"
          ? language.t("settings.models.context.min", { min: contextLabel(min()) })
          : issue() === "max"
            ? language.t("settings.models.context.max", { max: contextLabel(max()) })
            : language.t("settings.models.context.description")}
      </small>
      <Show when={chosen() !== null && started() !== undefined && started() !== chosen()}>
        <small data-slot="settings-model-context-effective">
          {language.t("settings.models.context.effective", { tokens: format(started()!) })}
        </small>
      </Show>
    </div>
  )
}

/** The harness of the model: how the agent works with it. «Open in Agent» shows what it reads and does. */
export const HarnessField: Component<FieldProps> = (props) => {
  const language = useLanguage()
  const open = useOpenSettings()
  const [list, { failed }] = createHarnessList()
  const chosen = () => props.model.choices.harness ?? list()?.default
  return (
    <Show
      when={list()}
      keyed
      fallback={
        <Show when={failed()}>
          {(message) => (
            <div class="settings-page-field">
              <b data-slot="settings-field-title">{language.t("settings.models.harness.title")}</b>
              <small>{language.t("settings.harness.listFailed", { message: message() })}</small>
            </div>
          )}
        </Show>
      }
    >
      {(current) => (
        <div class="settings-page-field">
          <b data-slot="settings-field-title">{language.t("settings.models.harness.title")}</b>
          <SelectV2
            appearance="inline"
            data-action="settings-model-harness"
            options={current.harnesses.filter((harness) => !harness.error)}
            current={current.harnesses.find((harness) => harness.id === chosen())}
            placement="bottom-end"
            gutter={6}
            disabled={props.disabled}
            value={(harness) => harness.id}
            label={(harness) => harness.name}
            onSelect={(harness) => {
              if (!harness || harness.id === chosen()) return
              void props.choose({ harness: harness.id === current.default ? null : harness.id })
            }}
          />
          {/* the harness chosen, its folder deleted or its harness.json broken: the agent stops with its name */}
          <Show when={!current.harnesses.some((harness) => harness.id === chosen() && !harness.error) && chosen()}>
            {(id) => (
              <small class="settings-page-error" role="alert" data-slot="settings-model-harness-missing">
                {language.t("settings.models.harness.missing", { id: id() })}
              </small>
            )}
          </Show>
          <small>
            {language.t("settings.models.harness.description")}{" "}
            <button
              type="button"
              class="settings-page-link"
              data-action="settings-model-harness-open"
              onClick={() => chosen() && open("agent", chosen())}
            >
              {language.t("settings.models.harness.open")}
            </button>
          </small>
        </div>
      )}
    </Show>
  )
}

/**
 * The three styles are shortcuts: each fills the six values. «Show the values» opens them to be written one by one; a
 * value changed makes a fourth segment, «Custom», and «Reset» goes back to the style that was chosen.
 */
export const StyleField: Component<FieldProps & { showValues: boolean; onShowValues: (shown: boolean) => void }> = (
  props,
) => {
  const language = useLanguage()
  const own = () => props.model.choices.sampling
  const custom = () => SAMPLING_KEYS.some((name) => own()[name] !== undefined)
  const shown = (name: keyof Sampling) => {
    const value = props.model.sampling?.[name]
    return value === undefined ? "" : samplingText(value, language.locale())
  }
  const [texts, setTexts] = createStore<Record<keyof Sampling, string>>({
    temperature: "",
    top_p: "",
    top_k: "",
    min_p: "",
    presence_penalty: "",
    repeat_penalty: "",
  })
  const [issue, setIssue] = createSignal<keyof Sampling>()
  // each box follows its own value only: a refresh after another box changed does not rewrite what is being typed here
  SAMPLING_KEYS.forEach((name) => {
    const value = createMemo(() => shown(name))
    createEffect(() => setTexts(name, value()))
  })

  const commit = (name: keyof Sampling) => {
    const typed = texts[name].trim()
    setIssue(undefined)
    // nothing written: the value goes back to the one of the style
    if (typed === "") {
      if (own()[name] !== undefined)
        void props.choose({ sampling: Object.fromEntries(Object.entries(own()).filter(([key]) => key !== name)) })
      return setTexts(name, shown(name))
    }
    const value = parseSamplingValue(name, typed)
    if (value === undefined || samplingIssue(name, value)) return setIssue(name)
    if (value !== props.model.sampling?.[name]) void props.choose({ sampling: { ...own(), [name]: value } })
  }

  return (
    <div class="settings-page-field">
      <b data-slot="settings-field-title">{language.t("settings.models.style.title")}</b>
      <SegmentedControlV2
        value={custom() ? "custom" : props.model.choices.style}
        disabled={props.disabled}
        onChange={(value) => {
          if (!value || value === "custom") return
          setIssue(undefined)
          void props.choose({ style: value as MangoModelChoices["style"], sampling: {} })
        }}
        data-action="settings-model-style"
        aria-label={language.t("settings.models.style.title")}
      >
        <For each={Object.keys(STYLES) as MangoModelChoices["style"][]}>
          {(style) => <SegmentedControlItemV2 value={style}>{language.t(STYLES[style].label)}</SegmentedControlItemV2>}
        </For>
        <Show when={custom()}>
          <SegmentedControlItemV2 value="custom">{language.t("settings.models.style.custom")}</SegmentedControlItemV2>
        </Show>
      </SegmentedControlV2>
      <small>
        {language.t(custom() ? "settings.models.style.custom.description" : STYLES[props.model.choices.style].line)}{" "}
        <button type="button" class="settings-page-link" onClick={() => props.onShowValues(!props.showValues)}>
          {language.t(props.showValues ? "settings.models.style.hideValues" : "settings.models.style.showValues")}
        </button>
      </small>
      <Show when={props.showValues}>
        <div class="settings-page-values" data-slot="settings-model-values">
          <For each={SAMPLING_KEYS}>
            {(name) => (
              <label class="settings-page-value">
                <span>{language.t(SAMPLING[name])}</span>
                <TextInputV2
                  numeric
                  appearance="base"
                  value={texts[name]}
                  invalid={issue() === name}
                  disabled={props.disabled}
                  onInput={(event) => setTexts(name, event.currentTarget.value)}
                  onBlur={() => commit(name)}
                  onKeyDown={(event) => event.key === "Enter" && commit(name)}
                  inputmode="decimal"
                  spellcheck={false}
                  autocomplete="off"
                  data-action={`settings-model-sampling-${name}`}
                />
              </label>
            )}
          </For>
        </div>
        <small data-tone={issue() ? "danger" : undefined} data-slot="settings-model-values-note">
          <Show
            when={issue()}
            fallback={
              <Show when={custom()} fallback={language.t("settings.models.style.hint")}>
                <button
                  type="button"
                  class="settings-page-link"
                  onClick={() => void props.choose({ sampling: {} })}
                  data-action="settings-model-style-reset"
                >
                  {language.t("settings.models.style.reset")}
                </button>
              </Show>
            }
          >
            {(name) =>
              language.t("settings.models.style.outside", {
                name: language.t(SAMPLING[name()]),
                range: language.t(SAMPLING_RANGES[name()].range),
              })
            }
          </Show>
        </small>
      </Show>
    </div>
  )
}
