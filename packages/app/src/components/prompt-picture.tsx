// mango-code: the picture side of the box a conversation is written in. A choice between «Text» and «Picture» sits
// first among its controls; on «Picture» what is written is the description of the picture, the menu lists the models
// that draw and are on the computer, and the format and the size are chosen beside the words. The state is the
// conversation's: it is kept in its prompt (`PicturePick`), and without a choice the conversation's last turn decides.
// With no model that draws on the computer the box says so and leads to the settings.
import { createEffect, createMemo, For, onCleanup, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { useModels } from "@/context/models"
import { type PicturePick, type usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { offered } from "@/utils/mango-state"
import { PICTURE_FORMATS, PICTURE_SIZES } from "@opencode-ai/session-ui/picture-state"
import {
  lastTurnWasPicture,
  offeredWriters,
  pictureMode,
  pictureModel,
  pictureModels,
  pictureRequest,
} from "@/utils/mango-picture"
import "./prompt-picture.css"

/** The conversation's picture box: what it asks, from the prompt it keeps and from the app's state. */
export function createPromptPicture(input: {
  prompt: Pick<ReturnType<typeof usePrompt>, "picture">
  sessionID: () => string | undefined
}) {
  const mango = useMango()
  const sync = useSync()
  const settings = useSettings()
  const models = useModels()
  const prompt = input.prompt

  // The app draws: an agent without it (started by hand) has no pictures to offer.
  const available = () => mango.available() && mango.imageModels() !== undefined
  const pick = () => prompt.picture.current()
  const lastWasPicture = createMemo(() => {
    const id = input.sessionID()
    if (!id) return false
    return lastTurnWasPicture(sync().data.message[id] ?? [], (messageID) => sync().data.part[messageID] ?? [])
  })
  const on = () => available() && pictureMode(pick(), lastWasPicture()) === "picture"

  // The engine that draws stays on while pictures are on view; the last view that goes puts it away.
  createEffect(() => {
    if (!on()) return
    onCleanup(mango.pictures.enter())
  })

  return {
    available,
    on,
    setMode: (mode: "text" | "picture") => prompt.picture.set({ mode }),
    pick,
    set: (change: PicturePick) => prompt.picture.set(change),
    models: () => pictureModels(mango.imageModels()),
    model: () => pictureModel(pick(), mango.imageModels()),
    /** Pictures are drawn here, but no model that draws is on the computer. */
    empty: () => available() && pictureModels(mango.imageModels()).length === 0,
    /** The request for these words, from the choices of the box and of the settings. */
    request: (text: string) =>
      pictureRequest({
        text,
        pick: pick(),
        images: mango.imageModels(),
        rewrite: settings.images.rewrite(),
        rewriter: settings.images.rewriter(),
        offered: offeredWriters(models.list(), {
          visible: models.visible,
          onDisk: (id) => offered(mango.state(), mango.catalog(), id),
        }).map((model) => ({ providerID: model.provider.id, modelID: model.id })),
      }),
    chooseModel: () => openPictureModels(mango),
  }
}

/** The settings, on the group of the models that draw. */
export function openPictureModels(mango: ReturnType<typeof useMango>) {
  const images = mango.imageModels()
  const key = images?.default ?? images?.models[0]?.key
  if (key) mango.openModelRow(key)
  else mango.openModels()
}

export type PromptPicture = ReturnType<typeof createPromptPicture>

/** «Text / Picture», first of the controls. */
export function PictureModeControl(props: { picture: PromptPicture }) {
  const language = useLanguage()
  return (
    <SegmentedControlV2
      data-action="prompt-mode"
      aria-label={language.t("picture.mode.label")}
      value={props.picture.on() ? "picture" : "text"}
      onChange={(value) => (value === "text" || value === "picture") && props.picture.setMode(value)}
    >
      <SegmentedControlItemV2 value="text" data-mode="text">
        {language.t("picture.mode.text")}
      </SegmentedControlItemV2>
      <SegmentedControlItemV2 value="picture" data-mode="picture">
        {language.t("picture.mode.picture")}
      </SegmentedControlItemV2>
    </SegmentedControlV2>
  )
}

/** The models that draw and are on the computer; the choice holds for this conversation. */
export function PictureModelControl(props: { picture: PromptPicture; onClose: () => void }) {
  const language = useLanguage()
  return (
    <Show when={props.picture.model()}>
      {(current) => (
        <MenuV2 gutter={6} modal={false} placement="top-start" onOpenChange={(open) => !open && props.onClose()}>
          <MenuV2.Trigger
            as={ButtonV2}
            variant="ghost-muted"
            size="normal"
            class="min-w-0 max-w-[220px] justify-start ![font-weight: 400]"
            style={{ height: "28px" }}
            data-action="prompt-picture-model"
            aria-label={language.t("picture.model.label")}
          >
            <span class="truncate leading-5">{current().label}</span>
            <span class="-ms-0.5 -me-1 flex shrink-0">
              <Icon name="chevron-down" />
            </span>
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.RadioGroup value={current().key} onChange={(key) => props.picture.set({ model: key })}>
                <For each={props.picture.models()}>
                  {(model) => (
                    <MenuV2.RadioItem value={model.key} closeOnSelect data-model={model.key}>
                      {model.label}
                    </MenuV2.RadioItem>
                  )}
                </For>
              </MenuV2.RadioGroup>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      )}
    </Show>
  )
}

/** The format and the size: one choice among a few short ones is a segmented control. */
export function PictureChoices(props: { picture: PromptPicture }) {
  const language = useLanguage()
  const format = () => props.picture.pick()?.format ?? "square"
  const size = () => props.picture.pick()?.size ?? "small"
  return (
    <>
      <SegmentedControlV2
        data-action="prompt-picture-format"
        aria-label={language.t("picture.format.label")}
        value={format()}
        onChange={(value) => value && props.picture.set({ format: PICTURE_FORMATS.find((item) => item === value) })}
      >
        <For each={PICTURE_FORMATS}>
          {(item) => (
            <SegmentedControlItemV2 value={item} data-picture-format={item}>
              {language.t(`picture.format.${item}`)}
            </SegmentedControlItemV2>
          )}
        </For>
      </SegmentedControlV2>
      <SegmentedControlV2
        data-action="prompt-picture-size"
        aria-label={language.t("picture.size.label")}
        value={size()}
        onChange={(value) => value && props.picture.set({ size: PICTURE_SIZES.find((item) => item === value) })}
      >
        <For each={PICTURE_SIZES}>
          {(item) => (
            <SegmentedControlItemV2 value={item} data-picture-size={item}>
              {language.t(`picture.size.${item}`)}
            </SegmentedControlItemV2>
          )}
        </For>
      </SegmentedControlV2>
    </>
  )
}

/** No model that draws is on the computer: one line, and the way to get one. */
export function PictureNotice(props: { picture: PromptPicture }) {
  const language = useLanguage()
  return (
    <div
      role="status"
      data-component="picture-notice"
      class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-[12px] leading-4 text-v2-text-text-muted"
    >
      <span>{language.t("picture.none")}</span>
      <ButtonV2 size="small" variant="neutral" data-action="picture-choose-model" onClick={props.picture.chooseModel}>
        {language.t("picture.none.action")}
      </ButtonV2>
    </div>
  )
}
