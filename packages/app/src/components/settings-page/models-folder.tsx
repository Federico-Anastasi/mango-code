// mango-code: moving the models. In Settings › Computer the row «Cartella dei modelli» changes the folder (the app starts
// again at the end); in Settings › Models a model's detail puts its files in another folder, or back, and the app goes on.
// Both ask first (what it would do, from the app's preview), then show how far it is, with «Annulla», in their own row.
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { ProgressBarV2 } from "@opencode-ai/ui/v2/progress-bar-v2"
import { formatFileSize } from "@opencode-ai/session-ui/project-file"
import { type Component, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import type { MangoMovePreview, MangoPlacePreview } from "@/utils/mango-desktop"
import { diskDrive, type CatalogEntry, type Computer } from "@/utils/mango-state"
import { SettingsRowV2 } from "../settings-v2/parts/row"
import { createCommands, useControl } from "./control"
import { folderAsk, modelAsk, moveOf, moveProgress, pathParts, type MoveAsk } from "./move"

/** A sentence with its paths in the code font. */
export const WithPaths: Component<{ text: string; paths: string[] }> = (props) => (
  <For each={pathParts(props.text, props.paths)}>
    {(part) =>
      part.path ? (
        <code class="settings-page-path">
          <For each={part.text.split(/(?<=\\)/)}>{(piece) => <>{piece}<wbr /></>}</For>
        </code>
      ) : (
        part.text
      )
    }
  </For>
)

/** The question before a move. `go` is the main button; for a folder that can only be used as it is, «Usa questa cartella». */
const Ask: Component<{
  ask: MoveAsk
  go: string
  busy: boolean
  onGo: () => void
  onUse?: () => void
  onDismiss: () => void
}> = (props) => {
  const language = useLanguage()
  return (
    <div class="settings-page-ask" data-slot="settings-move-ask">
      <b class="settings-page-ask-title" data-slot="settings-move-title">
        <WithPaths text={props.ask.title} paths={props.ask.paths} />
      </b>
      <For each={props.ask.paragraphs}>
        {(paragraph) => (
          <p data-slot="settings-move-text">
            <WithPaths text={paragraph} paths={props.ask.paths} />
          </p>
        )}
      </For>
      <div class="settings-page-ask-actions">
        <ButtonV2 variant="ghost" disabled={props.busy} onClick={props.onDismiss} data-action="settings-move-dismiss">
          {language.t("common.cancel")}
        </ButtonV2>
        <Show when={props.ask.action === "move"}>
          <ButtonV2 variant="primary" disabled={props.busy} onClick={props.onGo} data-action="settings-move-go">
            {props.go}
          </ButtonV2>
        </Show>
        <Show when={props.ask.action === "use"}>
          <ButtonV2 variant="neutral" disabled={props.busy} onClick={() => props.onUse?.()} data-action="settings-move-use">
            {language.t("settings.move.use")}
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}

/** The bar and the line of a move under way. */
const Progress: Component<{ progress: ReturnType<typeof moveProgress> }> = (props) => {
  const language = useLanguage()
  return (
    <>
      <ProgressBarV2 class="settings-page-progress" value={props.progress.value} label={language.t("settings.move.label")} />
      <span class="settings-page-row-line block" data-slot="settings-move-line">
        {props.progress.line}
      </span>
    </>
  )
}

/** The row «Cartella dei modelli» of Settings › Computer, with the question and the progress of a change. */
export const ModelsFolder: Component<{ disk: Computer["disk"] }> = (props) => {
  const language = useLanguage()
  const control = useControl()
  const dir = control.dir
  const api = () => window.__MANGO_DESKTOP__?.modelsDir
  const commands = createCommands(control.now)
  const [asked, setAsked] = createSignal<{ folder: string; preview: MangoMovePreview }>()
  // the preview counts files: the models that the move takes are those in the folder
  const models = () => {
    const catalog = (control.view.catalog ?? []).filter((m) => m.present && !m.placedIn && !m.ownFiles.length)
    return catalog.length + (control.view.images?.models.filter((m) => m.present).length ?? 0)
  }
  const ask = createMemo(() => {
    const found = asked()
    return found && folderAsk(found.preview, models(), language)
  })
  const mine = () => moveOf(dir.move(), dir.target(), "folder")
  const moving = () => {
    const found = mine()
    return found?.status === "moving" ? found : undefined
  }
  const progress = createMemo(() => {
    const found = moving()
    return found && moveProgress(found, language)
  })
  const path = () => dir.state()?.path ?? props.disk.path

  const choose = () =>
    commands.run("folder", async () => {
      const picked = await window.__MANGO_DESKTOP__?.pickDirectories({ title: language.t("settings.computer.modelsFolder") })
      const folder = picked?.[0]
      if (!folder) return
      const preview = await api()?.preview(folder)
      if (preview) setAsked({ folder, preview })
    })
  const start = (command: (folder: string) => Promise<void> | undefined) => {
    const folder = asked()?.folder
    if (!folder) return
    setAsked(undefined)
    dir.start("folder")
    void commands.run("folder", () => command(folder))
  }

  const label = () => {
    const found = mine()
    if (found?.status === "restarting") return <Tag variant="accent">{language.t("settings.move.restarting")}</Tag>
    if (found?.status === "moving") return <Tag variant="accent">{language.t("settings.move.label")}</Tag>
  }

  return (
    <>
      <SettingsRowV2
        title={
          <span class="settings-page-row-heading">
            {language.t("settings.computer.modelsFolder")}
            {label()}
          </span>
        }
        description={
          <>
            <Show
              when={progress()}
              fallback={
                <>
                  <Show
                    when={mine()?.status === "moved"}
                    fallback={
                      <>
                        <WithPaths text={path()} paths={[path()]} />
                        {" · "}
                        {language.t("settings.computer.modelsFolder.size", {
                          size: formatFileSize(props.disk.used_bytes, language.intl()),
                          drive: diskDrive(props.disk.path),
                        })}
                      </>
                    }
                  >
                    {(() => {
                      // the files left in the old folder and, if the app could not start again by itself, why
                      const found = mine()
                      if (found?.status !== "moved") return ""
                      const left = found.left.length ? language.t("settings.move.moved", { left: found.left.join(", ") }) : ""
                      return [left, found.reason ?? ""].filter(Boolean).join(" ")
                    })()}
                  </Show>
                  <Show when={failure(mine())}>
                    {(message) => (
                      <span class="settings-page-error block" role="alert" data-slot="settings-move-failed">
                        {message()}
                      </span>
                    )}
                  </Show>
                  <Show when={mine()?.status === "cancelled"}>
                    <span class="block" data-slot="settings-move-cancelled">
                      {language.t("settings.move.cancelled")}
                    </span>
                  </Show>
                </>
              }
            >
              {(shown) => <Progress progress={shown()} />}
            </Show>
            <Show when={commands.error("folder") ?? commands.error("stop")}>
              {(message) => (
                <span class="settings-page-error block" role="alert">
                  {message()}
                </span>
              )}
            </Show>
          </>
        }
      >
        <Switch>
          <Match when={moving()}>
            <ButtonV2
              variant="ghost"
              disabled={commands.busy("stop") || !progress()?.cancellable}
              onClick={() => void commands.run("stop", () => api()?.cancel())}
              data-action="settings-move-stop"
            >
              {language.t("common.cancel")}
            </ButtonV2>
          </Match>
          <Match when={mine()?.status === "moved"}>
            <ButtonV2
              variant="neutral"
              disabled={commands.busy("folder")}
              onClick={() => void commands.run("folder", () => api()?.restart())}
              data-action="settings-move-restart"
            >
              {language.t("settings.move.restart")}
            </ButtonV2>
          </Match>
          <Match when={mine()?.status !== "restarting" && !dir.state()?.pinned}>
            <ButtonV2
              variant="neutral"
              disabled={!api() || commands.busy("folder") || dir.busy()}
              onClick={() => void choose()}
              data-action="settings-folder-change"
              data-found-title={language.t("settings.computer.modelsFolder")}
            >
              {language.t("settings.computer.modelsFolder.change")}
            </ButtonV2>
          </Match>
        </Switch>
      </SettingsRowV2>
      <Show when={ask()}>
        {(question) => (
          <Ask
            ask={question()}
            go={language.t("settings.move.go")}
            busy={commands.busy("folder") || dir.busy()}
            onGo={() => start((folder) => api()?.move(folder))}
            onUse={() => start((folder) => api()?.use(folder))}
            onDismiss={() => setAsked(undefined)}
          />
        )}
      </Show>
    </>
  )
}

const failure = (move: ReturnType<typeof moveOf>) => (move?.status === "failed" ? move.message : undefined)

/**
 * One model's files in another folder, from its detail in Settings › Models: `run` is the row's own command runner (busy
 * and the sentence of a refusal under the row). The question and the progress go under the row's name.
 */
export function createModelMove(model: () => CatalogEntry, run: <T>(command: () => Promise<T> | undefined) => Promise<T | undefined>) {
  const language = useLanguage()
  const control = useControl()
  const dir = control.dir
  const api = () => window.__MANGO_DESKTOP__?.modelsDir
  const [asked, setAsked] = createSignal<{ folder: string; preview: MangoPlacePreview; back: boolean }>()
  const [stopping, setStopping] = createSignal(false)
  const mine = () => moveOf(dir.move(), dir.target(), model().key)
  const moving = () => {
    const found = mine()
    return found?.status === "moving" ? found : undefined
  }
  const home = () => dir.state()?.path ?? control.view.computer?.disk.path

  return {
    asked,
    mine,
    moving,
    progress: createMemo(() => {
      const found = moving()
      return found && moveProgress(found, language)
    }),
    ask: createMemo(() => {
      const found = asked()
      return found && modelAsk(found.preview, { name: model().label, folder: found.folder, back: found.back }, language)
    }),
    /** Only a model whose files Mango Code downloaded can be put elsewhere: those the user chose stay where they are. */
    eligible: () => !model().user && !model().ownFiles.length,
    busy: dir.busy,
    available: () => !!api(),
    dismiss: () => setAsked(undefined),
    choose: (back: boolean) =>
      run(async () => {
        const folder = back
          ? home()
          : (
              await window.__MANGO_DESKTOP__?.pickDirectories({
                title: language.t("settings.move.model.pick", { name: model().label }),
              })
            )?.[0]
        if (!folder) return
        const preview = await api()?.previewModel(model().key, back ? undefined : folder)
        if (preview) setAsked({ folder, preview, back })
      }),
    go: () => {
      const found = asked()
      if (!found) return
      setAsked(undefined)
      dir.start(model().key)
      void run(() => api()?.moveModel(model().key, found.back ? undefined : found.folder))
    },
    stopping,
    stop: async () => {
      setStopping(true)
      await run(() => api()?.cancel())
      setStopping(false)
    },
  }
}

export type ModelMove = ReturnType<typeof createModelMove>

/** «Sposta questo modello…» and, for a model that is elsewhere, «Riporta nella cartella dei modelli». */
export const ModelMoveActions: Component<{ move: ModelMove; busy: boolean }> = (props) => {
  const language = useLanguage()
  const disabled = () => !props.move.available() || props.busy || props.move.busy()
  return (
    <Show when={props.move.eligible()}>
      <ButtonV2
        variant="neutral"
        disabled={disabled()}
        onClick={() => void props.move.choose(false)}
        data-action="settings-model-move"
        data-found-title={language.t("settings.move.model.action")}
      >
        {language.t("settings.move.model.action")}
      </ButtonV2>
    </Show>
  )
}

/** The back button: only for a model whose files are not in the models folder. */
export const ModelMoveBack: Component<{ move: ModelMove; busy: boolean; placed: boolean }> = (props) => {
  const language = useLanguage()
  return (
    <Show when={props.move.eligible() && props.placed}>
      <ButtonV2
        variant="neutral"
        disabled={!props.move.available() || props.busy || props.move.busy()}
        onClick={() => void props.move.choose(true)}
        data-action="settings-model-move-back"
      >
        {language.t("settings.move.model.back")}
      </ButtonV2>
    </Show>
  )
}

/** What goes under a model's name while it moves: the question, the progress with «Annulla», or how it ended. */
export const ModelMoveStatus: Component<{ move: ModelMove; busy: boolean }> = (props) => {
  const language = useLanguage()
  return (
    <>
      <Show when={props.move.ask()}>
        {(question) => (
          <Ask
            ask={question()}
            go={language.t(props.move.asked()?.back ? "settings.move.back.go" : "settings.move.go")}
            busy={props.busy || props.move.busy()}
            onGo={props.move.go}
            onDismiss={props.move.dismiss}
          />
        )}
      </Show>
      <Show when={props.move.progress()}>
        {(progress) => (
          <div class="settings-page-ask settings-page-ask--run" data-slot="settings-model-move">
            <div class="settings-page-ask-copy">
              <Progress progress={progress()} />
            </div>
            <ButtonV2
              variant="ghost"
              disabled={props.move.stopping() || !progress().cancellable}
              onClick={() => void props.move.stop()}
              data-action="settings-move-stop"
            >
              {language.t("common.cancel")}
            </ButtonV2>
          </div>
        )}
      </Show>
      <Show when={failure(props.move.mine())}>
        {(message) => (
          <p class="settings-page-error settings-page-ask" role="alert" data-slot="settings-move-failed">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.move.mine()?.status === "cancelled"}>
        <p class="settings-page-note settings-page-ask" data-slot="settings-move-cancelled">
          {language.t("settings.move.cancelled")}
        </p>
      </Show>
    </>
  )
}
