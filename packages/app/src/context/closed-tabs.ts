import type { DraftTab, Tab } from "./tabs"

export function nextTabAfterClose(tabs: Tab[], index: number, active: boolean) {
  if (!active) return undefined
  return tabs[index + 1] ?? tabs[index - 1] ?? null
}

/**
 * The "New conversation" tab the user has just left, if it is empty (index in `tabs`), else -1: it closes by itself.
 * `isEmpty` says if nothing was written in it; where it cannot say (the tab was not opened since the app started),
 * the tab stays.
 */
export function leftEmptyDraft(tabs: Tab[], leftKey: string | undefined, isEmpty: (tab: DraftTab) => boolean) {
  return tabs.findIndex((tab) => tab.type === "draft" && `draft:${tab.draftID}` === leftKey && isEmpty(tab))
}
