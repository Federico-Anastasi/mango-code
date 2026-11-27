// mango-code: Settings › Models, the group of the models that make pictures. They are listed, downloaded and taken off the
// computer like the models that write, with the same words: the list comes from the answer of `/mango/models`
// (`image_models`), the downloads and the engine that is on from `/mango/state`, every change goes through the bridge.
// Under them, the two choices about the request: whether a model that writes rewrites it before the picture, and which.
// With no model that makes pictures in the catalog the group is not shown at all.
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, createMemo, For, Show } from "solid-js"
import { cardsText } from "@/components/mango-text"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { useModels } from "@/context/models"
import { type ImageRewriter, useSettings } from "@/context/settings"
import { MANGO_PROVIDER } from "@/utils/model-info"
import { offeredWriters } from "@/utils/mango-picture"
import { offered, type ImageModelEntry } from "@/utils/mango-state"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { type createCommands, useControl } from "./control"
import { removeLines } from "./lines"
import { RemoveModelDialog } from "./remove-model"
import { listedImages } from "./view"

/** The model that rewrites when the user chose none: Ling, the one the rules were made on, if it is on the computer. */
export const RECOMMENDED_REWRITER = "ling"

type Commands = ReturnType<typeof createCommands>

/** `open`: the key of the model whose row is open. `onToggle` opens a row and closes the one that was open. */
export const SettingsImages: Component<{ open?: string; onToggle: (key: string) => void; commands: Commands }> = (
  props,
) => {
  const language = useLanguage()
  const control = useControl()
  const view = control.view
  const downloads = () => view.state?.downloads ?? []

  return (
    <Show when={listedImages(view.images)}>
      {(images) => (
        <>
          <h3 class="settings-v2-section-title">{language.t("settings.models.section.images")}</h3>
          <div class="settings-page-box" data-slot="settings-images">
            <For each={images().models}>
              {(model) => (
                <ImageModelRow
                  model={model}
                  isDefault={images().default === model.key}
                  inUse={view.state?.image_loaded === model.key}
                  arriving={downloads().some((download) => download.model === model.key)}
                  open={props.open === model.key}
                  onToggle={() => props.onToggle(model.key)}
                  busy={props.commands.busy(model.key)}
                  error={props.commands.error(model.key)}
                  run={(command) => props.commands.run(model.key, command)}
                />
              )}
            </For>
            <RewriteRows />
          </div>
        </>
      )}
    </Show>
  )
}

type RowProps = {
  model: ImageModelEntry
  isDefault: boolean
  inUse: boolean
  arriving: boolean
  open: boolean
  onToggle: () => void
  busy: boolean
  error?: string
  run: <T>(command: () => Promise<T> | undefined) => Promise<T | undefined>
}

const ImageModelRow: Component<RowProps> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const models = () => window.__MANGO_DESKTOP__?.models
  const size = () => formatFileSize(props.model.bytes, language.locale())
  const where = () => cardsText(props.model.draws, language)
  const facts = (...more: string[]) => [props.model.license, where(), ...more].filter(Boolean).join(" · ")

  const copy = () => (
    <span class="settings-page-row-copy">
      <span class="settings-page-row-heading">
        <span data-slot="settings-v2-row-title">{props.model.label}</span>
        <Show when={props.isDefault}>
          <Tag variant="neutral">{language.t("settings.models.default.pill")}</Tag>
        </Show>
        <Show when={props.inUse}>
          <Tag variant="ready">{language.t("settings.models.inUse")}</Tag>
        </Show>
      </span>
      <Show when={props.model.about}>
        <span class="settings-page-row-line">{props.model.about}</span>
      </Show>
      <Show when={!props.model.present && props.error}>
        {(message) => (
          <p class="settings-page-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </span>
  )

  // The dialog asks about this model, by its key: what it names is what goes, whatever the list does meanwhile.
  const remove = () => {
    const { key, label } = props.model
    const run = props.run
    dialog.show(() => (
      <RemoveModelDialog
        label={label}
        size={size()}
        inUse={props.inUse}
        ownFiles={[]}
        onRemove={() => run(() => models()?.remove(key))}
      />
    ))
  }

  return (
    <Show
      when={props.model.present}
      fallback={
        // in the same wrapper as a row that opens, so that the card's lines between rows are the same
        <div
          class="settings-page-model"
          data-model-row={props.model.key}
          data-image-state={props.arriving ? "arriving" : "absent"}
        >
          <div class="settings-page-row">
            {copy()}
            <div class="settings-page-row-meta">
              <span class="settings-page-row-facts">{facts()}</span>
              <Show
                when={props.arriving}
                fallback={
                  <ButtonV2
                    variant="neutral"
                    disabled={!models() || props.busy}
                    onClick={() => void props.run(() => models()?.download([props.model.key]))}
                    data-action="settings-image-download"
                  >
                    {language.t("settings.models.download.action", { size: size() })}
                  </ButtonV2>
                }
              >
                <Tag>{language.t("settings.models.section.arriving")}</Tag>
              </Show>
            </div>
          </div>
        </div>
      }
    >
      <div
        class="settings-page-model"
        data-model-row={props.model.key}
        data-image-state="present"
        data-open={props.open ? "" : undefined}
      >
        <button
          type="button"
          class="settings-page-row settings-page-row--click"
          aria-expanded={props.open}
          onClick={props.onToggle}
        >
          {copy()}
          <span class="settings-page-row-meta">
            <span class="settings-page-row-facts">{facts(size())}</span>
            <IconV2 name="chevron-down" class={props.open ? "rotate-180" : ""} />
          </span>
        </button>
        <Show when={props.open}>
          <div class="settings-page-detail" data-slot="settings-image-detail">
            <div class="settings-page-actions">
              <Show when={!props.isDefault}>
                <ButtonV2
                  variant="neutral"
                  disabled={!models() || props.busy}
                  onClick={() => void props.run(() => models()?.setImageDefault(props.model.key))}
                  data-action="settings-image-default"
                >
                  {language.t("settings.models.default.action")}
                </ButtonV2>
              </Show>
              <ButtonV2
                variant="danger"
                disabled={!models() || props.busy}
                onClick={remove}
                data-action="settings-image-remove"
              >
                {removeLines({ label: props.model.label, size: size(), ownFiles: [] }, language.t).action}
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
    </Show>
  )
}

/** «Rewrite the request» and «Who rewrites»: choices of the interface, kept with the others (`images.*`). */
const RewriteRows: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  return (
    <>
      <SettingsRowV2
        title={language.t("settings.images.rewrite.title")}
        description={language.t("settings.images.rewrite.description")}
      >
        <div data-action="settings-image-rewrite">
          <Switch
            checked={settings.images.rewrite()}
            onChange={(checked) => settings.images.setRewrite(checked)}
            hideLabel
          >
            {language.t("settings.images.rewrite.title")}
          </Switch>
        </div>
      </SettingsRowV2>
      <SettingsRowV2
        title={language.t("settings.images.rewriter.title")}
        description={language.t(
          settings.images.rewrite() ? "settings.images.rewriter.description" : "settings.images.rewriter.off",
        )}
      >
        <RewriterSelect />
      </SettingsRowV2>
    </>
  )
}

type Choice = { value: string; label: string; model: ImageRewriter | null; recommended: boolean }

/**
 * The models that write which the agent offers, as the model menu of the conversation lists them: the visible ones, and
 * of this computer's only those on the disk. The first choice is automatic, the default. They come from the models
 * context the whole interface shares, so what the menu of a conversation shows and this list agree.
 */
const RewriterSelect: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const mango = useMango()
  const models = useModels()
  const choices = createMemo<Choice[]>(() => [
    { value: "auto", label: language.t("settings.images.rewriter.auto"), model: null, recommended: false },
    ...offeredWriters(models.list(), {
      visible: models.visible,
      onDisk: (id) => offered(mango.state(), mango.catalog(), id),
    }).map((item) => ({
      value: `${item.provider.id}:${item.id}`,
      label: item.name,
      model: { providerID: item.provider.id, modelID: item.id },
      recommended: item.provider.id === MANGO_PROVIDER && item.id === RECOMMENDED_REWRITER,
    })),
  ])
  // A rewriter that the agent no longer offers (a model taken off the computer, a provider disconnected) shows as
  // automatic, which is what a request would be given; the choice saved stays until the user makes another.
  const current = () => {
    const saved = settings.images.rewriter()
    return (
      choices().find(
        (choice) => saved && choice.model?.providerID === saved.providerID && choice.model.modelID === saved.modelID,
      ) ?? choices()[0]
    )
  }
  return (
    <SelectV2
      appearance="inline"
      data-action="settings-image-rewriter"
      aria-label={language.t("settings.images.rewriter.title")}
      disabled={!settings.images.rewrite()}
      options={choices()}
      current={current()}
      placement="bottom-end"
      gutter={6}
      value={(choice) => choice.value}
      label={(choice) => choice.label}
      onSelect={(choice) => choice && settings.images.setRewriter(choice.model)}
    >
      {(choice) => (
        <span class="settings-page-row-heading">
          {choice.label}
          <Show when={choice.recommended}>
            <Tag variant="accent">{language.t("settings.models.recommended")}</Tag>
          </Show>
        </span>
      )}
    </SelectV2>
  )
}
