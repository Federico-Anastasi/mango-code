// mango-code: Settings › Models. The list comes from
// the agent's `/mango/models`, the downloads and the model in use from `/mango/state`; every change goes through the
// bridge, which only the app's window has: elsewhere the controls stay visible, off, with «si fa dal computer».
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { type Component, createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { contextLabel, type CatalogEntry, type Download } from "@/utils/mango-state"
import { arrivingRows, diskLabel, downloadLine, removeLines, styleTemperature } from "./lines"
import { cardsText } from "@/components/mango-text"
import type { MangoModelChoices } from "@/utils/mango-desktop"
import { loadsDefaultNow, useAnswering } from "./answering"
import { createCommands, useControl } from "./control"
import { OtherModel } from "./other-model"
import { RemoveModelDialog } from "./remove-model"

const WHERE_LABELS = {
  auto: "settings.models.where.auto",
  one: "settings.models.where.one",
  all: "settings.models.where.all",
  cpu: "settings.models.where.cpu",
  pick: "settings.models.where.pick",
} as const
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

/** The titles of a model's own choices: a search result for one of them opens the first model, where they are. */
const FIELDS = [
  "settings.models.where.title",
  "settings.models.context.title",
  "settings.models.style.title",
  "settings.models.reasoning.title",
  "settings.models.default.action",
  "settings.models.remove.search",
] as const

/** `focus`: a model's key, whose row opens and comes into view, or the title of one of a model's choices. */
export const SettingsModels: Component<{ focus?: string }> = (props) => {
  const language = useLanguage()
  const bridge = () => window.__MANGO_DESKTOP__
  const control = useControl()
  const view = control.view
  const [ui, setUi] = createStore<{
    open?: string
    /** «Mostra i valori», by model: it stays with its model when the list changes. */
    values: Record<string, boolean>
  }>({ values: {} })
  const commands = createCommands(control.now)
  const mango = useMango()
  const answering = useAnswering()
  // The model made the default is saved, then loaded at once when no conversation is answering: the
  // next conversation finds it ready. A refusal of the load is said under its row, like one of the command.
  const makeDefault = async (model: CatalogEntry) => {
    await bridge()?.models?.setDefault(model.key)
    if (model.present && loadsDefaultNow(mango.state(), model.key, !!answering())) await mango.use(model.key)
  }
  createEffect(on(() => view.state?.revision, commands.clearErrors, { defer: true }))

  const models = () => view.catalog ?? []
  const downloads = () => view.state?.downloads ?? []
  const downloading = (key: string) => downloads().some((download) => download.model === key)
  // a model that waits for the new engine stays with those on the computer
  const present = createMemo(() => models().filter((model) => model.present || model.waitsEngine))
  const toDownload = createMemo(() =>
    models().filter((model) => !model.present && !model.waitsEngine && !downloading(model.key)),
  )
  const tried = () => toDownload().filter((model) => !model.user)
  const added = () => toDownload().filter((model) => model.user)
  const inUse = (key: string) => {
    const model = view.state?.model
    return model?.phase === "ready" && model.model === key
  }
  const loading = (key: string) => {
    const model = view.state?.model
    return model?.phase === "loading" && model.model === key
  }

  /** A model's row: in «In arrivo» while it comes, otherwise its own; none when the list does not have it. */
  const rowOf = (key: string) => {
    if (arrivingRows(downloads()).some((download) => download.model === key))
      return `[data-download-row="${CSS.escape(key)}"]`
    if ([...present(), ...toDownload()].some((model) => model.key === key))
      return `[data-model-row="${CSS.escape(key)}"]`
  }
  /** Opens a model's row, if it is on the computer, and brings it into view. False when the list does not have it. */
  const reveal = (key: string) => {
    const row = rowOf(key)
    if (!row) return false
    if (present().some((model) => model.key === key)) setUi("open", key)
    requestAnimationFrame(() => document.querySelector(row)?.scrollIntoView({ block: "center" }))
    return true
  }

  // The row asked for (from the search, the model menu, an error in the chat, the label of a download): opened, and in
  // view as soon as the list has it; for one of a model's choices, the first model on the computer opens, where they are.
  // Once: a list that changes later (a download that ends) does not open it or bring it into view again; once the
  // request is gone, the same row can be asked again.
  let used: string | undefined
  createEffect(
    on(
      [
        () => props.focus,
        () => [...present(), ...downloads()].map((row) => ("key" in row ? row.key : row.model)).join(),
      ],
      ([focus]) => {
        if (!focus) return void (used = undefined)
        if (focus === used) return
        const field = FIELDS.find((title) => language.t(title) === focus)
        if (!field) {
          if (reveal(focus)) used = focus
          return
        }
        // «Usa come predefinito» is only on a model that is not the default one, «Togli dal computer» on one whose
        // files Mango Code downloaded (a file of the user's is taken off the list)
        const host =
          field === "settings.models.default.action"
            ? present().find((model) => model.key !== view.state?.default_model)
            : field === "settings.models.remove.search"
              ? (present().find((model) => !model.ownFiles.length) ?? present()[0])
              : present()[0]
        if (!host) return
        used = focus
        setUi("open", host.key)
        requestAnimationFrame(() =>
          document.querySelector(`[data-model-row="${CSS.escape(host.key)}"]`)?.scrollIntoView({ block: "center" }),
        )
      },
    ),
  )

  const addModel = () => {
    const input = document.querySelector<HTMLInputElement>('[data-action="settings-other-model-search"] input')
    input?.scrollIntoView({ block: "center" })
    input?.focus()
  }

  return (
    <div class="settings-page-models" data-component="settings-models">
      <div class="settings-page-pane-header">
        <div class="settings-page-pane-heading">
          <h2 class="settings-page-pane-title">{language.t("settings.section.models")}</h2>
          <p class="settings-page-pane-description">{language.t("settings.models.lead")}</p>
        </div>
        <ButtonV2
          variant="contrast"
          disabled={!bridge()?.otherModels}
          onClick={addModel}
          data-action="settings-models-add"
        >
          {language.t("settings.models.add")}
        </ButtonV2>
      </div>

      <Show when={!bridge()?.models}>
        <p class="settings-page-note" data-slot="settings-pc-only">
          {language.t("settings.pcOnly")}
        </p>
      </Show>
      <Show when={view.failed}>
        <p class="settings-page-error">{language.t("settings.models.unreachable")}</p>
      </Show>
      <Show when={!view.catalog && !view.failed}>
        <Show
          when={view.catalogFailed}
          fallback={<p class="settings-page-note">{language.t("settings.models.reading")}</p>}
        >
          <p class="settings-page-error" role="alert" data-slot="settings-models-unreadable">
            {language.t("mango.models.unreadable")}
          </p>
        </Show>
      </Show>

      <Show when={present().length}>
        <h3 class="settings-v2-section-title">{language.t("settings.models.section.present")}</h3>
        <div class="settings-page-box">
          <For each={present()}>
            {(model) => (
              <PresentModel
                model={model}
                open={ui.open === model.key}
                onToggle={() => setUi("open", ui.open === model.key ? undefined : model.key)}
                isDefault={view.state?.default_model === model.key}
                inUse={inUse(model.key)}
                loading={loading(model.key)}
                gpus={view.computer?.gpus.filter((gpu) => gpu.used).map((gpu) => gpu.name) ?? []}
                busy={commands.busy(model.key)}
                error={commands.error(model.key)}
                run={(command) => commands.run(model.key, command)}
                onDefault={() => void commands.run(model.key, () => makeDefault(model))}
                showValues={!!ui.values[model.key]}
                onShowValues={(shown) => setUi("values", model.key, shown)}
              />
            )}
          </For>
        </div>
      </Show>

      <Show when={downloads().length}>
        <h3 class="settings-v2-section-title">{language.t("settings.models.section.arriving")}</h3>
        <div class="settings-page-box">
          <For each={arrivingRows(downloads())}>
            {(download) => (
              <ArrivingModel
                download={download}
                busy={commands.busy(download.model)}
                error={commands.error(download.model)}
                run={(command) => commands.run(download.model, command)}
              />
            )}
          </For>
        </div>
      </Show>

      <For
        each={
          [
            { title: "settings.models.section.catalog", list: tried },
            { title: "settings.models.section.user", list: added },
          ] as const
        }
      >
        {(group) => (
          <Show when={group.list().length}>
            <h3 class="settings-v2-section-title">{language.t(group.title)}</h3>
            <div class="settings-page-box">
              <For each={group.list()}>
                {(model) => (
                  <CatalogModel
                    model={model}
                    busy={commands.busy(model.key)}
                    error={commands.error(model.key)}
                    run={(command) => commands.run(model.key, command)}
                  />
                )}
              </For>
            </div>
          </Show>
        )}
      </For>

      <h3 class="settings-v2-section-title">{language.t("settings.models.other.title")}</h3>
      <OtherModel onAdded={() => void control.now()} hasRow={(key) => !!rowOf(key)} reveal={reveal} />

      <Show when={view.computer}>
        {(computer) => (
          <div class="settings-page-footer" data-slot="settings-models-disk">
            <span>{diskLabel(computer().disk, language.t, language.locale())}</span>
            <ButtonV2
              variant="ghost"
              size="small"
              disabled={!bridge()?.models}
              onClick={() => void commands.run("folder", () => bridge()?.models?.openFolder())}
              data-action="settings-models-folder"
              data-found-title={language.t("settings.models.folder.open")}
            >
              {language.t("settings.models.folder.open")}
            </ButtonV2>
            <Show when={commands.error("folder")}>
              {(message) => (
                <p class="settings-page-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

type RowProps = {
  busy: boolean
  error?: string
  run: <T>(command: () => Promise<T> | undefined) => Promise<T | undefined>
}

/**
 * «2 schede · 128k · 18,2 GB»: where it runs with these choices, its context, its weight, and «memoria stimata» for a
 * model of the user that the count does not know.
 */
function facts(model: CatalogEntry, language: ReturnType<typeof useLanguage>) {
  const where = model.verdict.where
  return [
    where && cardsText(where, language),
    where && contextLabel(where.context),
    formatFileSize(model.bytes, language.locale()),
    model.verdict.estimated && language.t("settings.models.estimated"),
  ].filter((value): value is string => !!value)
}

const PresentModel: Component<
  RowProps & {
    model: CatalogEntry
    open: boolean
    onToggle: () => void
    isDefault: boolean
    inUse: boolean
    loading: boolean
    gpus: string[]
    onDefault: () => void
    showValues: boolean
    onShowValues: (shown: boolean) => void
  }
> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const models = () => window.__MANGO_DESKTOP__?.models
  const choose = (patch: Partial<MangoModelChoices>) =>
    props.run(() => models()?.setChoices(props.model.key, { ...props.model.choices, ...patch }))
  const contexts = () => props.model.limits.context
  const context = () => props.model.choices.context ?? contexts().at(-1)
  const temperature = () => styleTemperature(props.model.choices.style, props.model.sampling)
  const values = () =>
    (Object.keys(SAMPLING) as (keyof typeof SAMPLING)[])
      .flatMap((name) => {
        const value = name === "temperature" ? temperature() : props.model.sampling?.[name]
        return value === undefined ? [] : [`${language.t(SAMPLING[name])} ${value.toLocaleString(language.locale())}`]
      })
      .join(" · ")
  const size = () => formatFileSize(props.model.bytes, language.locale())
  // The dialog asks about this model, by its key: what it names is what goes, whatever the list does meanwhile.
  const remove = () => {
    const { key, label, ownFiles } = props.model
    const run = props.run
    dialog.show(() => (
      <RemoveModelDialog
        label={label}
        size={size()}
        inUse={props.inUse || props.loading}
        ownFiles={ownFiles}
        onRemove={() => run(() => models()?.remove(key))}
      />
    ))
  }

  return (
    <div class="settings-page-model" data-model-row={props.model.key} data-open={props.open ? "" : undefined}>
      <button
        type="button"
        class="settings-page-row settings-page-row--click"
        aria-expanded={props.open}
        onClick={props.onToggle}
      >
        <span class="settings-page-row-copy">
          <span data-slot="settings-v2-row-title">{props.model.label}</span>
          <Show when={props.model.about}>
            <span class="settings-page-row-line">{props.model.about}</span>
          </Show>
          <Show when={props.model.waitsEngine}>
            <span class="settings-page-row-line" data-slot="settings-model-waits-engine">
              {language.t("settings.models.waitsEngine")}
            </span>
          </Show>
        </span>
        <span class="settings-page-row-meta">
          <Show when={props.isDefault}>
            <span class="settings-page-pill" data-tone="accent">
              {language.t("settings.models.default.pill")}
            </span>
          </Show>
          <Show when={props.inUse}>
            <span class="settings-page-pill" data-tone="ok">
              {language.t("settings.models.inUse")}
            </span>
          </Show>
          <Show when={props.loading}>
            <span class="settings-page-pill">{language.t("settings.models.loading")}</span>
          </Show>
          <Show when={!props.model.verdict.fits}>
            <span class="settings-page-pill" data-tone="bad" data-slot="settings-model-no-fit">
              {language.t("settings.models.other.noFit")}
            </span>
          </Show>
          <span>{facts(props.model, language).join(" · ")}</span>
          <IconV2 name="chevron-down" class={props.open ? "rotate-180" : ""} />
        </span>
      </button>

      <Show when={props.open}>
        <div class="settings-page-detail" data-slot="settings-model-detail">
          <div class="settings-page-field settings-page-field--wide">
            <b data-slot="settings-field-title">{language.t("settings.models.where.title")}</b>
            <SegmentedControlV2
              value={props.model.choices.where}
              disabled={!models() || props.busy}
              onChange={(value) => {
                if (!value) return
                const where = value as MangoModelChoices["where"]
                // «Scelgo io» starts from the cards it uses now, or all of them: a choice of no card is not valid
                const gpus =
                  where !== "pick"
                    ? []
                    : props.model.verdict.where?.gpus.length
                      ? props.model.verdict.where.gpus
                      : props.gpus
                void choose({ where, gpus })
              }}
              data-action="settings-model-where"
              aria-label={language.t("settings.models.where.title")}
            >
              <For each={props.model.limits.where}>
                {(where) => (
                  <SegmentedControlItemV2 value={where}>{language.t(WHERE_LABELS[where])}</SegmentedControlItemV2>
                )}
              </For>
            </SegmentedControlV2>
            <small>{props.model.verdict.reason}</small>
            <Show when={props.model.choices.where === "pick"}>
              <div class="settings-page-cards">
                <For each={props.gpus}>
                  {(gpu) => (
                    <label class="settings-page-card">
                      <Switch
                        checked={props.model.choices.gpus.includes(gpu)}
                        disabled={!models() || props.busy}
                        onChange={(checked) =>
                          void choose({
                            gpus: checked
                              ? [...props.model.choices.gpus, gpu]
                              : props.model.choices.gpus.filter((name) => name !== gpu),
                          })
                        }
                      />
                      <span>{gpu}</span>
                    </label>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <Show when={contexts().length}>
            <div class="settings-page-field">
              <b data-slot="settings-field-title">{language.t("settings.models.context.title")}</b>
              <SegmentedControlV2
                value={String(context())}
                disabled={!models() || props.busy}
                onChange={(value) => {
                  if (!value) return
                  // the largest offered is «as much as fits»: it follows the choices that change it
                  const tokens = Number(value)
                  void choose({ context: tokens === contexts().at(-1) ? null : tokens })
                }}
                data-action="settings-model-context"
                aria-label={language.t("settings.models.context.title")}
              >
                <For each={contexts()}>
                  {(tokens) => (
                    <SegmentedControlItemV2 value={String(tokens)}>{contextLabel(tokens)}</SegmentedControlItemV2>
                  )}
                </For>
              </SegmentedControlV2>
              <small>{language.t("settings.models.context.description")}</small>
            </div>
          </Show>

          <div class="settings-page-field">
            <b data-slot="settings-field-title">{language.t("settings.models.style.title")}</b>
            <SegmentedControlV2
              value={props.model.choices.style}
              disabled={!models() || props.busy}
              onChange={(value) => value && void choose({ style: value as MangoModelChoices["style"] })}
              data-action="settings-model-style"
              aria-label={language.t("settings.models.style.title")}
            >
              <For each={Object.keys(STYLES) as MangoModelChoices["style"][]}>
                {(style) => (
                  <SegmentedControlItemV2 value={style}>{language.t(STYLES[style].label)}</SegmentedControlItemV2>
                )}
              </For>
            </SegmentedControlV2>
            <small>
              {language.t(STYLES[props.model.choices.style].line)}{" "}
              <Show when={values()}>
                <button type="button" class="settings-page-link" onClick={() => props.onShowValues(!props.showValues)}>
                  {language.t(
                    props.showValues ? "settings.models.style.hideValues" : "settings.models.style.showValues",
                  )}
                </button>
              </Show>
            </small>
            <Show when={props.showValues}>
              <small data-slot="settings-model-values">{values()}</small>
            </Show>
          </div>

          <Show when={props.model.limits.reasoning}>
            <div class="settings-page-field">
              <b data-slot="settings-field-title">{language.t("settings.models.reasoning.title")}</b>
              <label class="settings-page-inline">
                <Switch
                  checked={props.model.choices.reasoning ?? true}
                  disabled={!models() || props.busy}
                  onChange={(checked) => void choose({ reasoning: checked })}
                  data-action="settings-model-reasoning"
                />
                <span>{language.t("settings.models.reasoning.description")}</span>
              </label>
            </div>
          </Show>

          <div class="settings-page-actions">
            <Show when={!props.isDefault}>
              <ButtonV2
                variant="neutral"
                disabled={!models() || props.busy}
                onClick={props.onDefault}
                data-action="settings-model-default"
                data-found-title={language.t("settings.models.default.action")}
              >
                {language.t("settings.models.default.action")}
              </ButtonV2>
            </Show>
            <ButtonV2
              variant="ghost"
              disabled={!models() || props.busy}
              onClick={remove}
              data-action="settings-model-remove"
              data-found-title={props.model.ownFiles.length ? undefined : language.t("settings.models.remove.search")}
            >
              {removeLines({ ...props.model, size: size() }, language.t).action}
            </ButtonV2>
          </div>
          <Show when={props.error}>
            {(message) => (
              <p class="settings-page-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}

const ArrivingModel: Component<RowProps & { download: Download }> = (props) => {
  const language = useLanguage()
  const models = () => window.__MANGO_DESKTOP__?.models
  const share = () => (props.download.total ? Math.min(100, (props.download.done / props.download.total) * 100) : 0)
  const key = () => props.download.model
  return (
    <div class="settings-page-row" data-download-row={key()} data-state={props.download.state}>
      <div class="settings-page-row-copy">
        <span data-slot="settings-v2-row-title">{props.download.label}</span>
        <span class="settings-page-row-line" data-tone={props.download.state === "failed" ? "danger" : undefined}>
          {downloadLine(props.download, language)}
        </span>
        <div
          class="settings-page-bar"
          role="progressbar"
          aria-label={props.download.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share())}
        >
          <u style={{ width: `${share()}%` }} />
        </div>
        <Show when={props.error}>
          {(message) => (
            <p class="settings-page-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <div class="settings-page-row-meta">
        <Show
          when={props.download.state === "active" || props.download.state === "waiting"}
          fallback={
            <ButtonV2
              variant="neutral"
              disabled={!models() || props.busy}
              onClick={() => void props.run(() => models()?.resume(key()))}
              data-action="settings-download-resume"
            >
              {language.t(
                props.download.state === "failed"
                  ? "settings.models.download.retry"
                  : "settings.models.download.resume",
              )}
            </ButtonV2>
          }
        >
          <ButtonV2
            variant="neutral"
            disabled={!models() || props.busy}
            onClick={() => void props.run(() => models()?.pause(key()))}
            data-action="settings-download-pause"
          >
            {language.t("settings.models.download.pause")}
          </ButtonV2>
        </Show>
        <ButtonV2
          variant="ghost"
          disabled={!models() || props.busy}
          onClick={() => void props.run(() => models()?.cancel(key()))}
          data-action="settings-download-cancel"
        >
          {language.t("settings.models.download.cancel")}
        </ButtonV2>
      </div>
    </div>
  )
}

const CatalogModel: Component<RowProps & { model: CatalogEntry }> = (props) => {
  const language = useLanguage()
  const bridge = () => window.__MANGO_DESKTOP__
  const fits = () => props.model.verdict.fits
  const verdict = () => {
    const where = props.model.verdict.where
    if (!fits() || !where) return props.model.verdict.reason
    return [
      language.t("settings.models.fits"),
      cardsText(where, language),
      contextLabel(where.context),
      props.model.verdict.estimated && language.t("settings.models.estimated"),
    ]
      .filter(Boolean)
      .join(" · ")
  }
  return (
    <div class="settings-page-row" data-model-row={props.model.key}>
      <div class="settings-page-row-copy">
        <span data-slot="settings-v2-row-title">{props.model.label}</span>
        <Show when={props.model.about}>
          <span class="settings-page-row-line">{props.model.about}</span>
        </Show>
        <Show when={props.error}>
          {(message) => (
            <p class="settings-page-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </div>
      <div class="settings-page-row-meta">
        <Show when={props.model.recommended}>
          <span class="settings-page-pill" data-tone="accent">
            {language.t("settings.models.recommended")}
          </span>
        </Show>
        <span class="settings-page-pill" data-tone={fits() ? "ok" : "bad"}>
          {verdict()}
        </span>
        <Show when={props.model.user}>
          <ButtonV2
            variant="ghost"
            disabled={!bridge()?.otherModels || props.busy}
            onClick={() => void props.run(() => bridge()?.otherModels?.remove(props.model.key))}
            data-action="settings-model-forget"
          >
            {language.t("settings.models.forget")}
          </ButtonV2>
        </Show>
        <Show when={fits()}>
          <ButtonV2
            variant="neutral"
            disabled={!bridge()?.models || props.busy}
            onClick={() => void props.run(() => bridge()?.models?.download([props.model.key]))}
            data-action="settings-model-download"
          >
            {language.t("settings.models.download.action", {
              size: formatFileSize(props.model.bytes, language.locale()),
            })}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}
