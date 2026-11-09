import { Component, createMemo, createResource, createSignal, Show, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { SettingsGeneralV2 } from "./general"
import { SettingsHelpV2 } from "./help"
import { SettingsLocalModelsV2 } from "./local-models"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import { SettingsPromptV2 } from "./prompt"
import { SettingsTeamV2 } from "./team"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { inMangoDesktop } from "@/utils/mango-desktop"
import { reportTarget } from "@/utils/report"
import { mangoVersion } from "@/utils/mango-version"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const [tab, setTab] = createSignal(props.defaultValue ?? "general")
  const [report] = createResource(reportTarget)
  // The project the settings are about: the one picked in the page, else the open tab's, else the one selected in
  // the home, else the first project. Opened from the home, the pages that depend on a project are never empty.
  const [picked, setPicked] = createSignal<string>()
  const routeDirectory = createMemo(() => {
    const route = layout.route()
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })
  const projects = createMemo(() =>
    layout.projects
      .list()
      .map((project) => ({ worktree: project.worktree, name: project.name || folderName(project.worktree) })),
  )
  const directory = createMemo(
    () => picked() ?? routeDirectory() ?? layout.home.selection().directory ?? projects()[0]?.worktree,
  )

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <Show when={inMangoDesktop()}>
                      <TabsV2.Trigger value="local-models">
                        <Icon name="models" />
                        {language.t("settings.tab.localModels")}
                      </TabsV2.Trigger>
                    </Show>
                    <TabsV2.Trigger value="prompt">
                      <Icon name="bullet-list" />
                      {language.t("settings.tab.prompt")}
                    </TabsV2.Trigger>
                    <Show when={window.__MANGO_DESKTOP__?.team}>
                      <TabsV2.Trigger value="team">
                        <Icon name="brain" />
                        {language.t("settings.tab.team")}
                      </TabsV2.Trigger>
                    </Show>
                    {/* "Report a problem" is also from the phone: the app on the computer sends it */}
                    <Show when={report()}>
                      <TabsV2.Trigger value="help">
                        <Icon name="help" />
                        {language.t("settings.tab.help")}
                      </TabsV2.Trigger>
                    </Show>
                  </div>
                </div>

                {/* in the Mango Code app there is a single local model: no providers, servers and models */}
                <Show when={!inMangoDesktop()}>
                  <div class="flex flex-col gap-1.5">
                    <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <TabsV2.Trigger value="servers">
                        <Icon name="server" />
                        {language.t("status.popover.tab.servers")}
                      </TabsV2.Trigger>
                      <TabsV2.Trigger value="providers">
                        <Icon name="providers" />
                        {language.t("settings.providers.title")}
                      </TabsV2.Trigger>
                      <TabsV2.Trigger value="models">
                        <Icon name="models" />
                        {language.t("settings.models.title")}
                      </TabsV2.Trigger>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{mangoVersion}</span>
            </div>
          </div>
        </TabsV2.List>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="local-models" class="settings-v2-panel">
          <SettingsLocalModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="prompt" class="settings-v2-panel">
          <SettingsPromptV2 directory={directory} projects={projects} onPick={setPicked} />
        </TabsV2.Content>
        <TabsV2.Content value="team" class="settings-v2-panel">
          <SettingsTeamV2 />
        </TabsV2.Content>
        <TabsV2.Content value="help" class="settings-v2-panel">
          <SettingsHelpV2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 directory={directory} onBack={showProviders} />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}

function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
