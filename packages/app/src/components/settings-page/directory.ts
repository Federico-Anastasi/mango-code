// mango-code: the project the settings are about when the user has not picked one: the one of the tab seen last, else the
// one selected in the home, else the first project. The Agent section and the models that rewrite a picture's request
// read their project's configuration from it.
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"

export function useSettingsProject() {
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const projects = createMemo(() => layout.projects.list())
  const lastTab = () => tabs.store.findLast((tab) => tab.type !== "settings")
  const tabDirectory = () => {
    const tab = lastTab()
    if (tab?.type === "draft") return tab.directory
    if (tab?.type === "session") return serverSync().session.get(tab.sessionId)?.directory
  }
  return {
    projects,
    directory: createMemo(() => tabDirectory() ?? layout.home.selection().directory ?? projects()[0]?.worktree),
  }
}
