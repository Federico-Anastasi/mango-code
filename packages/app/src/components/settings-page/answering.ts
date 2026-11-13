// mango-code: what the settings page knows of the conversations while it is open:
// the one that is answering, which the page names in a line at the top, and whether
// a new default loads at once.
import { createMemo } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { tabKey, useTabs, type Tab, type TabInfo } from "@/context/tabs"
import type { MangoState } from "@/utils/mango-state"

/** The first open conversation that is answering, with its title when its tab has one. */
export function answeringTab(
  tabs: readonly Tab[],
  info: Record<string, TabInfo | undefined>,
  working: (sessionID: string) => boolean,
) {
  const tab = tabs.find((tab) => tab.type === "session" && working(tab.sessionId))
  if (tab) return { title: info[tabKey(tab)]?.title }
}

/**
 * A model made the default loads at once, so that the next conversation finds it ready. Not while a conversation
 * answers (its model stays), nor when it is already in use or on its way, nor when this PC's models are not the ones
 * in use (the other PC's engine, the cards lent).
 */
export function loadsDefaultNow(state: MangoState | undefined, key: string, answering: boolean) {
  const model = state?.model
  if (!model || answering || model.phase === "remote" || model.phase === "lent") return false
  return !((model.phase === "ready" || model.phase === "loading") && model.model === key)
}

export function useAnswering() {
  const tabs = useTabs()
  const serverSync = useServerSync()
  return createMemo(() => answeringTab(tabs.store, tabs.info, (id) => serverSync().session.data.session_working(id)))
}
