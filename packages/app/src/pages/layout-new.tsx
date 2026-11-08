import { createEffect, onCleanup, Show, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { PreviewPanel } from "@/components/preview-panel"
import { TabsInfoPopup } from "@/components/help-button"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { usePreview } from "@/context/preview"
import { ServerConnection } from "@/context/server"
import { displayName } from "@/pages/layout/helpers"
import { onMissingDirectory } from "@/utils/missing-directory"
import { pathKey } from "@/utils/path-key"
import { setV2Toast, showToast, ToastRegion } from "@/utils/toast"

// A project folder gone from the disk: the project is removed from the list and the user is warned once.
function useMissingProjectCleanup() {
  const global = useGlobal()
  const layout = useLayout()
  const language = useLanguage()
  const recent = new Map<string, number>()

  onCleanup(
    onMissingDirectory((directory) => {
      const key = pathKey(directory)
      if (Date.now() - (recent.get(key) ?? 0) < 30_000) return
      recent.set(key, Date.now())

      let name: string | undefined
      for (const conn of global.servers.list()) {
        const projects = global.ensureServerCtx(conn).projects
        for (const project of projects.list()) {
          if (pathKey(project.worktree) !== key) continue
          name = displayName(project)
          projects.remove(project.worktree)
          const selected = layout.home.selection()
          if (selected.directory && pathKey(selected.directory) === key) {
            layout.home.setSelection({ server: ServerConnection.key(conn) })
          }
        }
      }
      showToast({
        variant: "error",
        title: language.t("toast.project.directoryMissing.title"),
        description: name
          ? language.t("toast.project.directoryMissing.description", { project: name })
          : language.t("toast.directory.missing.description"),
      })
    }),
  )
}

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const preview = usePreview()
  const [state, setState] = createStore({ debugTools: true })

  createEffect(() => setV2Toast(true))
  useMissingProjectCleanup()

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        preview={{ opened: preview.opened, toggle: preview.toggle }}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div class="flex-1 min-h-0 min-w-0 flex">
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden flex flex-col items-start contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
        <Show when={preview.opened()}>
          <PreviewPanel
            width={preview.width()}
            device={preview.device()}
            onResize={preview.resize}
            onDevice={preview.setDevice}
            onClose={preview.close}
          />
        </Show>
      </div>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
