import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"

import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "@/components/titlebar-tab-strip"
import { PreviewToggle } from "@/components/preview-panel"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { ServerConnection, useServer } from "@/context/server"
import { tabKey, useTabs } from "@/context/tabs"
import { useDefaultProject } from "@/hooks/use-default-project"
import type { PromptSession } from "@/context/prompt"
import "./titlebar.css"
import { newTabTooltipKeybind } from "./command-tooltip-keybind"
import { normalizeSessionInfo } from "@/utils/session"
import { sessionTitle } from "@/utils/session-title"
import { useServerSync } from "@/context/server-sync"
import { phoneBarActions, phoneChanges } from "@/utils/phone-changes"
import { phonePreview, previewFailed } from "@/utils/phone-preview"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"

const legacyTitlebarHeight = 40
const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.
const macTrafficLightsBaseWidth = 84

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function useTitlebarRightMount() {
  const language = useLanguage()
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  const sync = () => setMount(document.getElementById("opencode-titlebar-right"))
  onMount(sync)
  createEffect(on(language.direction, sync, { defer: true }))
  return mount
}

export function Titlebar(props: {
  update?: TitlebarUpdate
  /** The Preview panel: the button that opens/closes it is in the bar. */
  preview?: { opened: () => boolean; toggle: () => void }
  debugTools?: { visible: boolean; toggle: () => void }
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const serverSync = useServerSync()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => useV2Titlebar() && mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const macTrafficLights = createMemo(() => mac() && !platform.windowFullscreen?.())
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = useV2Titlebar() ? v2TitlebarHeight : legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft" || route.type === "dir-new-sesssion") return true
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))
  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: language.t("titlebar.update"),
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? language.t("titlebar.updateVersion", { version }) : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-slot={useV2Titlebar() ? "titlebar-v2" : undefined}
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 max-md:h-12 bg-v2-background-bg-deep overflow-visible": useV2Titlebar(),
        "h-10 bg-background-base overflow-hidden": !useV2Titlebar(),
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": macTrafficLights() ? `${macTrafficLightsBaseWidth / zoom()}px` : 0,
        width: windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        // Native Windows caption controls remain on the physical right in both writing directions.
        "margin-right": windows() ? "auto" : undefined,
      }}
      data-tauri-drag-region
    >
      <Switch>
        <Match when={useV2Titlebar()}>
          {(_) => {
            const layout = useLayout()
            const global = useGlobal()

            const tabs = useTabs()
            const defaultProject = useDefaultProject()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const [session] = createResource(
              () => {
                const route = layout.route()
                if (route.type !== "session") return undefined
                const conn = global.servers
                  .list()
                  .find((item) => ServerConnection.key(item) === (route.server ?? server.key))
                return conn ? { route, sdk: global.ensureServerCtx(conn).sdk } : undefined
              },
              ({ route, sdk }) =>
                sdk.api.session
                  .get({ sessionID: route.sessionId })
                  .then(normalizeSessionInfo)
                  .catch(() => {}),
            )

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
                )
                if (main) return main
                const s = session()
                if (s?.parentID) {
                  const parentID = s.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) {
                tabs.remember(tab)
                return
              }

              if (route.type === "session") {
                const s = session()
                if (!s) return
                const sessionId = s.parentID ?? s.id
                const next = { server: route.server ?? server.key, sessionId }
                tabsStoreActions.addSessionTab(next)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const openNewTab = () => {
              const route = layout.route()
              const activeSession = session()
              if (route.type === "session" && activeSession) {
                const sessionTab = {
                  type: "session" as const,
                  server: route.server ?? server.key,
                  sessionId: activeSession.id,
                }
                const model = tabs.stateValue<PromptSession>(sessionTab, "prompt")?.model.current()
                tabs.newDraft({ server: sessionTab.server, directory: activeSession.directory }, "", model)
                return
              }

              const activeTab = currentTab()
              if (activeTab?.type === "draft") {
                const model = tabs.stateValue<PromptSession>(activeTab, "prompt")?.model.current()
                tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
                return
              }

              if (route.type === "home") {
                const selection = layout.home.selection()
                const conn = global.servers.list().find((item) => ServerConnection.key(item) === selection.server)
                const project = conn
                  ? global
                      .ensureServerCtx(conn)
                      .projects.list()
                      .find((item) => item.worktree === selection.directory)
                  : undefined
                if (conn && project) {
                  tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
                  return
                }
              }

              const current = layout.projects.list()[0]
              if (current) {
                tabs.newDraft({ server: server.key, directory: current.worktree }, "")
                return
              }

              const fallback = global.servers.list().flatMap((conn) => {
                const project = global.ensureServerCtx(conn).projects.list()[0]
                return project ? [{ server: ServerConnection.key(conn), project }] : []
              })[0]
              if (fallback) {
                tabs.newDraft({ server: fallback.server, directory: fallback.project.worktree }, "")
                return
              }

              // no project at all: the conversation goes to the default folder (only inside the app)
              void defaultProject?.().then((directory) => {
                if (directory) tabs.newDraft({ server: server.key, directory }, "")
              })
            }
            const toggleHome = () => tabs.toggleHome({ home: layout.route().type === "home", current: currentTab() })

            command.register("titlebar-home", () => [
              {
                id: "home.toggle",
                title: language.t("home.title"),
                category: language.t("command.category.view"),
                keybind: "mod+b",
                hidden: true,
                onSelect: toggleHome,
              },
            ])

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t,mod+n",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.closeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: "tab.reopenClosed",
                  category: language.t("command.category.file"),
                  title: language.t("command.tab.reopenClosed"),
                  keybind: "mod+shift+t",
                  onSelect: () => tabsStoreActions.reopenClosedTab(),
                },
              ].filter((v) => v !== undefined)
            })

            // On a phone the bar is one row. In the Home: the mark and the settings. In a conversation: the arrow that goes one level up
            // (from the changes to the conversation, from the conversation to the Home), the title, a new conversation, the changes and
            // the menu of the conversation (which the page puts in the bar, with the settings inside). Elsewhere the arrow,
            // the title and the settings. The row of tabs and the browser panel are for the computer.
            const onHome = () => layout.route().type === "home"
            const inSession = () => layout.route().type === "session"
            const barTitle = () => {
              const route = layout.route()
              if (route.type === "session" && phoneChanges.opened()) return language.t("session.review.change.other")
              if (route.type !== "session") return language.t("session.untitled")
              // the title the conversation has now (it is born untitled and gets its name after the first answer)
              return sessionTitle(
                serverSync().session.get(route.sessionId)?.title ?? session()?.title,
                language.t("session.untitled"),
              )
            }
            createEffect(
              on(
                () => {
                  const route = layout.route()
                  return route.type === "session" ? route.sessionId : route.type
                },
                () => {
                  phoneChanges.close()
                  phonePreview.close()
                },
                { defer: true },
              ),
            )

            return (
              <Show
                when={!mobile()}
                fallback={
                  <div
                    data-component="titlebar-mobile"
                    class="flex h-full min-w-0 flex-1 flex-row items-center gap-0.5 px-1"
                  >
                    <Show
                      when={!onHome()}
                      fallback={
                        <h1 class="ml-3 flex min-w-0 flex-1 items-center">
                          <WordmarkV2 class="h-6 w-auto text-v2-background-bg-inverse" />
                          <span class="sr-only">Mango Code</span>
                        </h1>
                      }
                    >
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="!size-11 shrink-0"
                        icon={<IconV2 name="chevron-left" />}
                        onClick={() => (phoneChanges.opened() ? phoneChanges.close() : toggleHome())}
                        aria-label={language.t("common.goBack")}
                        data-action="titlebar-back"
                      />
                      <h1 class="min-w-0 flex-1 truncate px-1 text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">
                        {barTitle()}
                      </h1>
                    </Show>
                    <Show when={updateState().visible}>
                      <TitlebarUpdateIconButton state={updateState()} />
                    </Show>
                    <Show when={inSession()}>
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="!size-11 shrink-0"
                        icon={<IconV2 name="edit" />}
                        onClick={openNewTab}
                        aria-label={language.t("command.session.new")}
                        data-action="titlebar-new"
                      />
                      <Show when={phonePreview.available()}>
                        <IconButtonV2
                          type="button"
                          variant="ghost-muted"
                          size="large"
                          class="!size-11 shrink-0"
                          icon={<IconV2 name="globe" />}
                          onClick={() => {
                            const route = layout.route()
                            void phonePreview
                              .open(route.type === "session" ? route.sessionId : undefined)
                              .catch(previewFailed(language.t("preview.phone.failed")))
                          }}
                          aria-label={language.t("preview.toggle")}
                          data-action="titlebar-preview"
                        />
                      </Show>
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="!size-11 shrink-0"
                        state={phoneChanges.opened() ? "pressed" : undefined}
                        icon={<IconV2 name="sidebar-right" />}
                        onClick={phoneChanges.toggle}
                        aria-pressed={phoneChanges.opened()}
                        aria-label={language.t("session.review.change.other")}
                        data-action="titlebar-changes"
                      />
                      <div
                        data-slot="phone-session-actions"
                        class="flex shrink-0 items-center"
                        ref={(el) => {
                          phoneBarActions.set(el)
                          onCleanup(() => phoneBarActions.set(undefined))
                        }}
                      />
                    </Show>
                    <Show when={!inSession()}>
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="!size-11 shrink-0"
                        icon={<IconV2 name="settings-gear" />}
                        onClick={() => command.trigger("settings.open")}
                        aria-label={language.t("command.settings.open")}
                        data-action="titlebar-settings"
                      />
                    </Show>
                  </div>
                }
              >
                <div
                  class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3"
                  classList={{
                    "pt-2": !bottom(),
                    "pb-2": bottom(),
                    "md:pl-2": macTrafficLights(),
                    "md:pl-4": !macTrafficLights(),
                  }}
                >
                  <ChannelIndicator debugTools={props.debugTools} />
                  <Show when={windows() || linux()}>
                    <WindowsAppMenu command={command} platform={platform} variant="v2" />
                  </Show>
                  <TooltipV2
                    placement="bottom"
                    value={
                      <>
                        {language.t("titlebar.history.tooltip")}
                        <KeybindV2 keys={command.keybindParts("home.toggle")} variant="neutral" />
                      </>
                    }
                    class="shrink-0"
                  >
                    <ButtonV2
                      type="button"
                      variant={layout.route().type === "home" ? "neutral" : "ghost-muted"}
                      size="large"
                      class="shrink-0"
                      icon="menu"
                      onClick={toggleHome}
                      aria-pressed={layout.route().type === "home"}
                    >
                      {language.t("titlebar.history")}
                    </ButtonV2>
                  </TooltipV2>

                  <TitlebarTabStrip
                    tabs={tabsStore}
                    currentTab={currentTab}
                    onNavigate={(tab, el) => {
                      tabs.select(tab)
                      el?.scrollIntoView({ behavior: "instant" })
                    }}
                    onClose={(tab) => {
                      const index = tabsStore.findIndex((item) => tabKey(item) === tabKey(tab))
                      if (index !== -1) tabsStoreActions.closeTab(index)
                    }}
                    onReorder={(keys) => tabsStoreActions.reorder(keys)}
                  />
                  <TooltipV2
                    placement="bottom"
                    value={
                      <>
                        {language.t("command.session.new")}
                        <KeybindV2 keys={newTabTooltipKeybind(command)} variant="neutral" />
                      </>
                    }
                  >
                    <IconButtonV2
                      type="button"
                      variant="ghost-muted"
                      size="large"
                      class="shrink-0"
                      icon={<IconV2 name="plus" />}
                      onClick={openNewTab}
                      aria-label={language.t("command.session.new")}
                    />
                  </TooltipV2>
                  <div class="flex-1" />
                  <Show when={props.preview}>
                    <PreviewToggle opened={props.preview!.opened} toggle={props.preview!.toggle} />
                  </Show>
                  <TitlebarV2Right state={v2RightState()} />
                  <TooltipV2 placement="bottom" value={language.t("command.settings.open")}>
                    <IconButtonV2
                      type="button"
                      variant="ghost-muted"
                      size="large"
                      class="shrink-0"
                      icon={<IconV2 name="settings-gear" />}
                      onClick={() => command.trigger("settings.open")}
                      aria-label={language.t("command.settings.open")}
                      data-action="titlebar-settings"
                    />
                  </TooltipV2>
                </div>
              </Show>
            )
          }}
        </Match>
        <Match when>
          <div
            class="grid h-full min-h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
            style={{ zoom: counterZoom() }}
          >
            <div
              classList={{
                "flex items-center min-w-0": true,
                "pl-2": !macTrafficLights(),
              }}
            >
              <Show when={windows() || linux()}>
                <WindowsAppMenu command={command} platform={platform} />
              </Show>
              <Show when={mac()}>
                <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <Show when={!mac()}>
                <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <div class="flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
                <div class="hidden xl:flex items-center shrink-0">
                  <Show when={params.dir}>
                    <div
                      class="flex items-center shrink-0 w-8 mr-1"
                      aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                    >
                      <div
                        class="transition-opacity"
                        classList={{
                          "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                          "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                        }}
                      >
                        <TooltipKeybind
                          placement="bottom"
                          title={language.t("command.session.new")}
                          keybind={command.keybind("session.new")}
                          openDelay={800}
                        >
                          <Button
                            variant="ghost"
                            class="titlebar-icon w-8 h-6 p-0 box-border"
                            disabled={layout.sidebar.opened()}
                            tabIndex={layout.sidebar.opened() ? -1 : undefined}
                            onClick={() => {
                              if (!params.dir) return
                              navigate(`/${params.dir}/session`)
                            }}
                            aria-label={language.t("command.session.new")}
                            aria-current={creating() ? "page" : undefined}
                          >
                            <IconV2 name="edit" size="small" />
                          </Button>
                        </TooltipKeybind>
                      </div>
                    </div>
                  </Show>
                  <div
                    class="flex items-center shrink-0"
                    classList={{
                      "ltr:-translate-x-[36px] rtl:translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                      "duration-180 ease-out": !layout.sidebar.opened(),
                      "duration-180 ease-in": layout.sidebar.opened(),
                    }}
                  >
                    <Show when={hasProjects() && nav()}>
                      <div class="flex items-center gap-0 transition-transform">
                        <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-left"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canBack()}
                            onClick={back}
                            aria-label={language.t("common.goBack")}
                          />
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-right"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canForward()}
                            onClick={forward}
                            aria-label={language.t("common.goForward")}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                    <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                  </div>
                </div>
                <ChannelIndicator debugTools={props.debugTools} />
              </div>
            </div>

            <div class="min-w-0 flex items-center justify-center pointer-events-none">
              <div
                id="opencode-titlebar-center"
                class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full"
              />
            </div>

            <div
              classList={{
                "flex items-center min-w-0 justify-end": true,
                "pr-2": !windows(),
              }}
              data-tauri-drag-region
            >
              <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end">
                <Show when={props.preview}>
                  <PreviewToggle opened={props.preview!.opened} toggle={props.preview!.toggle} />
                </Show>
              </div>
              <Show when={windows()}>
                <div class="shrink-0" style={{ width: windowsControlsWidth() }} />
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        class="absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-v2-icon-icon-accent/20 text-v2-icon-icon-accent transition-[width,background-color] duration-150 ease-out group-hover:w-[68px] group-hover:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] group-focus-within:w-[68px] group-focus-within:bg-[color-mix(in_srgb,var(--v2-icon-icon-accent)_20%,var(--v2-background-bg-deep))] focus-visible:outline-none disabled:opacity-60 motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-[8px] mr-px text-[11px] text-v2-text-text-accent [font-weight:530] opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-within:opacity-100 group-focus-within:translate-x-0 motion-reduce:translate-x-0">
          {props.state.label}
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

function ChannelIndicator(props: { debugTools?: { visible: boolean; toggle: () => void } }) {
  const channel = import.meta.env.VITE_OPENCODE_CHANNEL
  if (channel === "dev" && props.debugTools) {
    return (
      <button
        type="button"
        class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono cursor-pointer"
        onClick={props.debugTools.toggle}
        aria-label="Toggle debug tools"
        aria-pressed={props.debugTools.visible}
      >
        DEV
      </button>
    )
  }

  return (
    <>
      {["beta", "dev"].includes(channel) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {channel.toUpperCase()}
        </div>
      )}
    </>
  )
}
