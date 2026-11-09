import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useData } from "../context"
import { formatFileSize, projectFileKind, projectFileKindKey, projectFileProblem } from "./project-file"

type Info = { size: number } | { problem: ReturnType<typeof projectFileProblem> }

/**
 * Type and size of a project file, with "Open" and, where there is a folder to show, "Show in folder". Without the desktop app
 * or the phone port (a normal browser) there is no way to touch the disk: only the type is shown, no buttons.
 * The buttons are `span`, not `button`: they also sit inside the clickable header of a file.
 */
export function ProjectFileMeta(props: { path: string; details?: boolean }) {
  const data = useData()
  const i18n = useI18n()
  const [failed, setFailed] = createSignal<ReturnType<typeof projectFileProblem>>()

  // A signal, not a resource: a pending resource read here suspends the nearest Suspense, which is the
  // whole conversation. If the app answers late (or never) the chat went blank and stayed blank.
  const [info, setInfo] = createSignal<Info>()
  createEffect(() => {
    const files = data.files
    const path = props.path
    setInfo(undefined)
    if (!files) return
    let current = true
    onCleanup(() => (current = false))
    files.info(path).then(
      (found) => current && setInfo({ size: found.size }),
      (cause: unknown) => current && setInfo({ problem: projectFileProblem(cause) }),
    )
  })

  const problem = () => {
    const found = info()
    return failed() ?? (found && "problem" in found ? found.problem : undefined)
  }
  const size = () => {
    const found = info()
    return found && "size" in found ? formatFileSize(found.size, i18n.locale()) : undefined
  }

  const run = (event: Event, action: "open" | "reveal") => {
    event.stopPropagation()
    event.preventDefault()
    data.files![action]!(props.path).then(
      () => setFailed(undefined),
      (cause: unknown) => setFailed(projectFileProblem(cause)),
    )
  }
  const press = (action: "open" | "reveal") => ({
    role: "button" as const,
    tabindex: 0,
    onClick: (event: MouseEvent) => run(event, action),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") run(event, action)
    },
  })

  return (
    <span data-slot="project-file-meta">
      <Show when={props.details}>
        <span data-slot="project-file-type">
          {[i18n.t(projectFileKindKey(projectFileKind(props.path))), size()].filter(Boolean).join(" · ")}
        </span>
      </Show>
      <Show when={data.files}>
        <Show
          when={problem() !== "missing"}
          fallback={<span data-slot="project-file-problem">{i18n.t("ui.file.missing")}</span>}
        >
          <span data-slot="project-file-action" {...press("open")}>
            {i18n.t("ui.file.open")}
          </span>
          <Show when={data.files?.reveal}>
            <span data-slot="project-file-action" {...press("reveal")}>
              {i18n.t("ui.file.reveal")}
            </span>
          </Show>
          <Show when={problem()}>
            {(why) => (
              <span data-slot="project-file-problem">
                {i18n.t(why() === "blocked" ? "ui.file.blocked" : "ui.file.openFailed")}
              </span>
            )}
          </Show>
        </Show>
      </Show>
    </span>
  )
}
