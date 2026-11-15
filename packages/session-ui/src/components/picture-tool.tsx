// mango-code: the row of `image_generate` in the conversation, for the picture the user asked for (a turn of the
// conversation) and for the one the model made by itself: the same row, the same frame. While it is made the row says
// what it is doing and the frame shows the picture as it forms; when it is made the picture is shown, a click opens its
// file in the panel, and its description can be corrected to make it again.
import { createMemo, createSignal, Show } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { ProgressBarV2 } from "@opencode-ai/ui/v2/progress-bar-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useData } from "../context"
import { BasicTool } from "./basic-tool"
import type { ToolProps } from "./message-part"
import {
  pictureAgain,
  pictureDescription,
  pictureFileName,
  pictureFrameWidth,
  pictureProgress,
  pictureSeconds,
  pictureSides,
  pictureWords,
} from "./picture-state"
import "./picture-tool.css"

export function PictureTool(props: ToolProps) {
  const data = useData()
  const i18n = useI18n()
  const dialog = useDialog()
  const stopped = () => props.status === "error" && props.metadata.stopped === true
  const missing = () => props.status === "error" && props.metadata.missing === true
  const running = () => props.status === "pending" || props.status === "running"
  const done = () => props.status === "completed"
  const sides = createMemo(() => pictureSides(props.metadata))
  // The frame has its proportions once the turn says how big the picture is.
  const sized = () => typeof props.metadata.width === "number" && typeof props.metadata.height === "number"
  const progress = () => pictureProgress(props.metadata)
  const words = () => {
    const { key, params } = pictureWords(props.metadata)
    return i18n.t(key, params)
  }
  const picture = () => (props.attachments ?? []).find((file) => file.mime.startsWith("image/"))
  const preview = () => (typeof props.metadata.preview === "string" ? props.metadata.preview : undefined)
  const file = () => (typeof props.metadata.file === "string" ? props.metadata.file : undefined)
  const seconds = () => pictureSeconds(props.time)
  const facts = () => {
    const { width, height } = sides()
    const key = seconds() === undefined ? "ui.picture.factsSize" : "ui.picture.facts"
    return i18n.t(key, { seconds: seconds() ?? 0, width, height })
  }
  const frame = () => ({
    width: `${pictureFrameWidth(sides())}px`,
    "aspect-ratio": `${sides().width} / ${sides().height}`,
  })

  const open = () => {
    const path = file()
    const found = picture()
    if (path && data.files) return void data.files.open(path).catch(() => undefined)
    if (found) dialog.show(() => <ImagePreview src={found.url} alt={words()} />)
  }

  return (
    <div data-component="picture-tool" data-state={stopped() ? "stopped" : missing() ? "missing" : props.status}>
      <BasicTool
        icon="photo"
        status={stopped() || missing() ? "stopped" : props.status}
        // a finished picture says how long it took once, in the line under it
        time={done() ? undefined : props.time}
        progress={words()}
        outcome={stopped() ? i18n.t("ui.picture.stopped") : missing() ? i18n.t("ui.picture.missing") : undefined}
        trigger={{ title: props.label.title, subtitle: pictureFileName(props.metadata) }}
        hideDetails
      />
      <Show when={missing() && data.pictures}>
        {(pictures) => (
          <div data-slot="picture-meta">
            <ButtonV2 variant="neutral" size="small" data-action="picture-choose-model" onClick={pictures().chooseModel}>
              {i18n.t("ui.picture.missing.action")}
            </ButtonV2>
          </div>
        )}
      </Show>
      <Show when={running() && sized()}>
        <div data-slot="picture-frame" data-drawing style={frame()}>
          <Show when={preview()}>
            {(png) => (
              <img
                data-slot="picture-preview"
                src={`data:image/png;base64,${png()}`}
                alt={i18n.t("ui.picture.drawing")}
              />
            )}
          </Show>
          <Show when={progress() !== undefined}>
            <ProgressBarV2 data-slot="picture-progress" value={progress()!} label={i18n.t("ui.picture.progress")} />
          </Show>
        </div>
      </Show>
      <Show when={done() && picture()}>
        {(found) => (
          <>
            <button
              type="button"
              data-slot="picture-frame"
              data-action="picture-open"
              style={frame()}
              aria-label={i18n.t("ui.picture.open")}
              onClick={open}
            >
              <img
                data-slot="picture-image"
                src={found().url}
                alt={String(props.input.request ?? props.input.prompt ?? "")}
              />
            </button>
            <PictureActions facts={facts()} input={props.input} metadata={props.metadata} />
          </>
        )}
      </Show>
    </div>
  )
}

/** The description of a finished picture, to correct, and the way to make it again. */
function PictureActions(props: { facts: string; input: Record<string, unknown>; metadata: Record<string, unknown> }) {
  const data = useData()
  const i18n = useI18n()
  const stored = () => pictureDescription(props.input)
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal<string>()
  const written = () => text() ?? stored() ?? ""
  // Making it again is the user's own turn: not while the conversation is busy, and not for a picture the model made by itself.
  const record = () => ({ input: props.input, metadata: props.metadata })
  const again = (prompt: string) => {
    const asked = pictureAgain(record(), prompt)
    if (asked) void data.pictures?.again(asked)
  }
  const ready = () => !!data.pictures && !data.pictures.busy() && !!pictureAgain(record(), stored() ?? "x")

  return (
    <>
      <div data-slot="picture-meta">
        <p data-slot="picture-facts">{props.facts}</p>
        <Show when={stored() && ready()}>
          <ButtonV2 variant="ghost" size="small" data-action="picture-again" onClick={() => again(stored()!)}>
            {i18n.t("ui.picture.again")}
          </ButtonV2>
        </Show>
      </div>
      <Show when={stored()}>
        <div data-slot="picture-description" data-open={open() ? "" : undefined}>
          <button
            type="button"
            data-action="picture-description"
            aria-expanded={open()}
            onClick={() => setOpen(!open())}
          >
            <span>{i18n.t("ui.picture.description")}</span>
            <span data-slot="picture-description-chevron" aria-hidden="true" />
          </button>
          <Show when={open()}>
            <p data-slot="picture-description-hint">{i18n.t("ui.picture.description.hint")}</p>
            <TextareaV2
              data-slot="picture-description-field"
              aria-label={i18n.t("ui.picture.description.field")}
              rows={4}
              value={written()}
              readOnly={!ready()}
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <Show when={ready()}>
              <div data-slot="picture-actions">
                <ButtonV2
                  variant="neutral"
                  data-action="picture-again-description"
                  disabled={!written().trim()}
                  onClick={() => again(written())}
                >
                  {i18n.t("ui.picture.againWithDescription")}
                </ButtonV2>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  )
}
