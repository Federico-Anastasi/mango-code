import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { PROJECT_FRUITS } from "@opencode-ai/ui/v2/project-fruits"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { type LocalProject } from "@/context/layout"
import { fruitColor, projectFruit, storedFruit } from "@/context/project-fruit"
import { ServerConnection } from "@/context/server"
import { getProjectAvatarSource } from "@/pages/layout/helpers"
import { createEditProjectModel } from "./edit-project"

export function DialogEditProjectV2(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const model = createEditProjectModel(props)
  const previewFruit = () => projectFruit({ ...props.project, icon: { ...props.project.icon, color: model.store.color } })

  return (
    <Dialog fit>
      <form onSubmit={model.submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("dialog.project.edit.title")}</DialogTitle>
        </DialogHeader>
        <DividerV2 />
        <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-6 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("dialog.project.edit.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={model.store.name}
              placeholder={model.folderName()}
              onInput={(event) => model.setStore("name", event.currentTarget.value)}
            />
          </Field>

          <div class="flex w-full flex-col gap-2">
            <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
              {language.t("dialog.project.edit.icon")}
            </div>
            <div class="flex items-center gap-3">
              <button
                type="button"
                aria-label={language.t("dialog.project.edit.icon.alt")}
                class="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-[6px] outline outline-1 outline-transparent transition-[background-color,outline-color] focus-visible:outline-v2-border-border-focus"
                classList={{
                  "bg-v2-overlay-simple-overlay-hover outline-v2-border-border-focus": model.store.dragOver,
                }}
                onMouseEnter={() => model.setStore("iconHover", true)}
                onMouseLeave={() => model.setStore("iconHover", false)}
                onDrop={model.drop}
                onDragOver={model.dragOver}
                onDragLeave={model.dragLeave}
                onClick={model.iconClick}
              >
                <ProjectAvatar
                  fallback={model.store.name || model.defaultName()}
                  src={getProjectAvatarSource(props.project.id, {
                    color: model.store.color,
                    url: props.project.icon?.url,
                    override: model.store.iconOverride,
                  })}
                  fruit={previewFruit()}
                  class="!size-16 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[32px]"
                />
                <span
                  class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[6px] bg-v2-background-bg-contrast/80 text-v2-icon-icon-contrast backdrop-blur-[2px] transition-opacity"
                  classList={{
                    "opacity-100": model.store.iconHover,
                    "opacity-0": !model.store.iconHover,
                  }}
                >
                  <Icon name={model.store.iconOverride ? "close" : "outline-share"} />
                </span>
              </button>
              <input
                ref={(element) => {
                  model.setIconInput(element)
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={model.inputChange}
              />
              <div class="flex select-none flex-col gap-[6px] text-[11px] font-[440] leading-none tracking-[0.05px] text-v2-text-text-muted">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
              </div>
            </div>
          </div>

          <Show when={!model.store.iconOverride}>
            <div class="flex w-full flex-col gap-2">
              <div class="flex items-center justify-between gap-3">
                <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base">
                  {language.t("dialog.project.edit.fruit")}
                </div>
                <Show when={storedFruit(model.store.color)}>
                  <button
                    type="button"
                    class="cursor-pointer rounded-sm px-1 text-[12px] font-[440] leading-none text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
                    onClick={() => model.setStore("color", undefined)}
                  >
                    {language.t("dialog.project.edit.fruit.auto")}
                  </button>
                </Show>
              </div>
              <div class="-ml-1 grid grid-cols-8 gap-1.5" role="group" aria-label={language.t("dialog.project.edit.fruit")}>
                <For each={PROJECT_FRUITS}>
                  {(fruit) => (
                    <button
                      type="button"
                      aria-label={language.t(`project.fruit.${fruit}`)}
                      title={language.t(`project.fruit.${fruit}`)}
                      aria-pressed={storedFruit(model.store.color) === fruit}
                      class="flex size-8 cursor-pointer items-center justify-center rounded-[10px] p-1 outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-v2-border-border-focus"
                      classList={{
                        "bg-v2-overlay-simple-overlay-hover [box-shadow:inset_0_0_0_2px_var(--v2-border-border-focus)]":
                          storedFruit(model.store.color) === fruit,
                      }}
                      onClick={() =>
                        model.setStore("color", storedFruit(model.store.color) === fruit ? undefined : fruitColor(fruit))
                      }
                    >
                      <ProjectAvatar
                        fallback={model.store.name || model.defaultName()}
                        fruit={fruit}
                        class="!size-6 [&_[data-slot=project-avatar-surface]]:!rounded-[6px]"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Field>
            <Field.Label>{language.t("dialog.project.edit.worktree.startup")}</Field.Label>
            <Field.Prefix>{language.t("dialog.project.edit.worktree.startup.description")}</Field.Prefix>
            <TextareaV2
              class="!w-full [&_[data-slot=textarea-v2-textarea]]:font-mono"
              rows={3}
              value={model.store.startup}
              placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
              spellcheck={false}
              onInput={(event) => model.setStore("startup", event.currentTarget.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 type="button" variant="neutral" disabled={model.save.isPending} onClick={model.close}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 type="submit" variant="contrast" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </ButtonV2>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
