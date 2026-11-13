import { Dialog } from "@opencode-ai/ui/dialog"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { List } from "@opencode-ai/ui/list"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createMemo, createSignal, lazy } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useSettings } from "@/context/settings"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"

const DialogSelectFileV2 = lazy(() =>
  import("./dialog-select-directory-v2").then((module) => ({ default: module.DialogSelectDirectoryV2 })),
)

const ENTRY_LIMIT = 5

type FileEntry = {
  id: string
  title: string
  category: string
  path: string
}

export function DialogSelectFile(props: { onOpenFile?: (path: string) => void }) {
  const platform = usePlatform()
  const settings = useSettings()

  if (platform.platform === "desktop" && settings.general.newLayoutDesigns()) {
    return <DialogSelectFileDesktopV2 onOpenFile={props.onOpenFile} />
  }

  return <DialogSelectFileLegacy onOpenFile={props.onOpenFile} />
}

function DialogSelectFileDesktopV2(props: { onOpenFile?: (path: string) => void }) {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const { params } = useSessionLayout()
  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const openFile = createFileOpener(props.onOpenFile)

  return (
    <DialogSelectFileV2
      server={serverSDK().server}
      mode="file"
      start={projectDirectory()}
      title={language.t("session.header.searchFiles")}
      onSelect={(result) => {
        if (typeof result !== "string") return
        openFile(result)
      }}
    />
  )
}

function DialogSelectFileLegacy(props: { onOpenFile?: (path: string) => void }) {
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const { tabs } = useSessionLayout()
  const openFile = createFileOpener(props.onOpenFile)
  const [grouped, setGrouped] = createSignal(false)

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const entry = (path: string): FileEntry => ({
    id: "file:" + path,
    title: path,
    category: language.t("palette.group.files"),
    path,
  })
  const recentEntries = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    return order
      .map((item) => file.pathFromTab(item))
      .filter((path): path is string => {
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
      .slice(0, ENTRY_LIMIT)
      .map(entry)
  })
  const rootEntries = createMemo(() =>
    file.tree
      .children("")
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, ENTRY_LIMIT)
      .map(entry),
  )
  const unique = () => {
    const seen = new Set<string>()
    return [...recentEntries(), ...rootEntries()].filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
  }

  const items = async (text: string) => {
    const query = text.trim()
    setGrouped(query.length > 0)

    if (!query) {
      const loaded = file.tree.state("")?.loaded
      const pending = loaded ? Promise.resolve() : file.tree.list("")
      const next = unique()

      if (loaded || next.length > 0) {
        void pending
        return next
      }

      await pending
      return unique()
    }

    return (await file.searchFiles(query)).map(entry)
  }

  return (
    <Dialog class="pt-3 pb-0 !max-h-[480px]" transition>
      <List
        class="px-3"
        search={{
          placeholder: language.t("session.header.searchFiles"),
          autofocus: true,
          hideIcon: true,
        }}
        emptyMessage={language.t("palette.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "category"]}
        skipFilter={() => true}
        groupBy={grouped() ? (item) => item.category : () => ""}
        onSelect={(item: FileEntry | undefined) => {
          if (!item) return
          dialog.close()
          openFile(item.path)
        }}
      >
        {(item) => (
          <div class="w-full flex items-center justify-between rounded-md pl-1">
            <div class="flex items-center gap-x-3 grow min-w-0">
              <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
              <div class="flex items-center text-14-regular">
                <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                  {getDirectory(item.path)}
                </span>
                <span class="text-text-strong whitespace-nowrap">{getFilename(item.path)}</span>
              </div>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}

function createFileOpener(onOpenFile?: (path: string) => void) {
  const file = useFile()
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()

  return (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    onOpenFile?.(path)
    tabs().setActive(value)
  }
}
