import { createMemo, createSignal, For, Show } from "solid-js"
import { DateTime } from "luxon"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { projectFruit } from "@/context/project-fruit"
import { ServerConnection } from "@/context/server"
import { displayName, getProjectAvatarSource } from "@/pages/layout/helpers"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { HomeSessionStatusController, type HomeSessionRecord } from "./home-sessions-controller"
import type { HomeSessionsController } from "./home-sessions-controller"
import type { HomeProjectsController } from "./home-projects-controller"
import { DialogDeleteSession, DialogRenameSession } from "./home-session-dialogs"
import { filterHomeGroups } from "./home-mobile-filter"

/**
 * The Home on a phone: one column made for the thumb. The way to start a conversation, the projects as a row of buttons that
 * narrows the list, a search field and the conversations (the most recent first) as big rows; what a row can do is in its menu.
 */
export function HomeMobile(props: { projects: HomeProjectsController; sessions: HomeSessionsController }) {
  const language = props.sessions.copy.language
  const [query, setQuery] = createSignal("")
  const selection = props.projects.selection.value
  const server = createMemo(() =>
    props.projects.server.list().find((item) => ServerConnection.key(item) === selection().server),
  )
  const archived = () => props.sessions.view.value() === "archived"
  const groups = createMemo(() =>
    filterHomeGroups(
      props.sessions.data.groups(),
      query(),
      (title) => sessionTitle(title, language.t("session.untitled")) ?? "",
    ),
  )

  return (
    <div data-component="home-mobile" class="flex min-h-0 flex-1 flex-col">
      <Show
        when={!archived()}
        fallback={
          <div class="flex shrink-0 px-3 pb-3 pt-4">
            <ButtonV2
              data-action="home-toggle-archived"
              variant="ghost-muted"
              size="large"
              class="!h-11 px-3 text-[16px]"
              onClick={() => props.sessions.view.set("active")}
            >
              {language.t("home.sessions.archived.back")}
            </ButtonV2>
          </div>
        }
      >
        <div class="flex shrink-0 flex-col gap-3 px-3 pb-3 pt-4">
          {/* with no project at all the first conversation is the computer's (it makes the folder): the button says so */}
          <Show when={props.sessions.session.canCreate() || props.sessions.data.projectsRead()}>
            <ButtonV2
              data-action="home-new-session"
              variant="contrast"
              size="large"
              icon="edit"
              class="!h-12 w-full justify-center text-[16px]"
              disabled={!props.sessions.session.canCreate()}
              onClick={props.sessions.session.create}
            >
              {language.t("command.session.new")}
            </ButtonV2>
            <Show when={!props.sessions.session.canCreate()}>
              <p data-slot="home-pc-only" class="px-1 text-[13px] leading-5 text-v2-text-text-muted">
                {language.t("settings.pcOnly")}
              </p>
            </Show>
          </Show>
          <Show when={props.projects.project.list().length > 1}>
            <div
              class="-mx-3 flex gap-2 overflow-x-auto px-3 no-scrollbar"
              role="group"
              aria-label={language.t("home.projects")}
            >
              <For each={props.projects.project.list()}>
                {(project) => (
                  <button
                    type="button"
                    data-component="home-project-chip"
                    data-selected={selection().directory === project.worktree ? "" : undefined}
                    class="flex h-11 shrink-0 items-center gap-2 rounded-full border border-v2-border-border-base bg-v2-background-bg-layer-01 pl-3 pr-4 text-[15px] text-v2-text-text-muted data-[selected]:bg-v2-background-bg-layer-03 data-[selected]:text-v2-text-text-base"
                    aria-pressed={selection().directory === project.worktree}
                    onClick={() => {
                      const conn = server()
                      if (conn) props.projects.project.select(conn, project.worktree)
                    }}
                  >
                    <ProjectAvatar
                      fallback={displayName(project)}
                      src={getProjectAvatarSource(project.id, project.icon)}
                      fruit={projectFruit(project)}
                    />
                    <span class="max-w-[40vw] truncate">{displayName(project)}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="flex items-center gap-2">
            <label class="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-v2-background-bg-layer-02/60 pl-3 pr-3 text-v2-icon-icon-muted focus-within:bg-v2-background-bg-layer-02">
              <IconV2 name="magnifying-glass" />
              <input
                class="min-w-0 flex-1 border-0 bg-transparent text-[16px] text-v2-text-text-base outline-0 placeholder:text-v2-text-text-faint"
                type="search"
                enterkeyhint="search"
                value={query()}
                placeholder={language.t("home.sessions.search.placeholder")}
                aria-label={language.t("home.sessions.search.placeholder")}
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <IconButtonV2
              type="button"
              data-action="home-toggle-archived"
              variant="ghost-muted"
              size="large"
              class="!size-12 shrink-0"
              icon={<IconV2 name="archive" />}
              aria-label={language.t("home.sessions.archived.open")}
              onClick={() => props.sessions.view.set("archived")}
            />
          </div>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6">
        <Show when={!archived()} fallback={<HomeMobileArchived sessions={props.sessions} />}>
          <Show
            when={groups().length > 0}
            fallback={
              <p class="px-4 pt-10 text-center text-[15px] leading-6 text-v2-text-text-muted">
                {query()
                  ? language.t("home.sessions.search.noResults", { query: query() })
                  : language.t("home.sessions.empty")}
              </p>
            }
          >
            <For each={groups()}>
              {(group) => (
                <section class="pb-2">
                  <h2 class="px-3 pb-1 pt-3 text-[14px] text-v2-text-text-muted [font-weight:440]">{group.title}</h2>
                  <For each={group.sessions}>
                    {(record) => <HomeMobileRow record={record} sessions={props.sessions} />}
                  </For>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function HomeMobileRow(props: { record: HomeSessionRecord; sessions: HomeSessionsController; archived?: boolean }) {
  const dialog = useDialog()
  const language = props.sessions.copy.language
  const title = createMemo(
    () => sessionTitle(props.record.session.title, language.t("session.untitled")) || props.record.session.id,
  )
  const when = createMemo(() => {
    const time = DateTime.fromMillis(props.record.session.time.updated ?? props.record.session.time.created)
    return time.hasSame(DateTime.local(), "day")
      ? time.toLocaleString(DateTime.TIME_SIMPLE)
      : time.toLocaleString(DateTime.DATE_MED)
  })
  return (
    <div class="relative flex items-center">
      <button
        type="button"
        data-component="home-session-row"
        disabled={props.archived}
        class="flex min-h-16 w-full min-w-0 items-center gap-3 rounded-[10px] border-0 bg-transparent py-2 pl-3 pr-14 text-left active:bg-v2-overlay-simple-overlay-hover"
        onClick={() => props.sessions.session.open(props.record.session)}
      >
        <HomeSessionStatusController
          server={props.sessions.session.server}
          record={props.record}
          isOpenTab={props.sessions.tab.isOpen}
          render={(state) => (
            <SessionTabAvatarView
              project={props.record.project}
              directory={props.record.session.directory}
              revealProjectOnHover={false}
              unread={state.unread()}
              loading={state.loading()}
            />
          )}
        />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">{title()}</span>
          <span class="block truncate text-[14px] leading-5 text-v2-text-text-muted [font-weight:440]">
            {props.record.projectName} · {when()}
          </span>
        </span>
      </button>
      <MenuV2 gutter={6} placement="bottom-end">
        <MenuV2.Trigger
          as={IconButtonV2}
          data-action="home-session-menu"
          variant="ghost-muted"
          size="large"
          class="absolute right-1 top-1/2 !size-11 -translate-y-1/2"
          icon={<IconV2 name="outline-dots" />}
          aria-label={language.t("common.moreOptions")}
        />
        <MenuV2.Portal>
          <MenuV2.Content style={{ width: "180px", "min-width": "180px" }}>
            <Show
              when={!props.archived}
              fallback={
                <MenuV2.Item onSelect={() => void props.sessions.session.restore(props.record.session)}>
                  {language.t("home.session.restore")}
                </MenuV2.Item>
              }
            >
              <MenuV2.Item
                onSelect={() =>
                  dialog.show(() => (
                    <DialogRenameSession
                      title={title()}
                      onRename={(next) => void props.sessions.session.rename(props.record.session, next)}
                    />
                  ))
                }
              >
                {language.t("common.rename")}...
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => void props.sessions.session.archive(props.record.session)}>
                {language.t("common.archive")}
              </MenuV2.Item>
            </Show>
            <MenuV2.Separator />
            <MenuV2.Item
              onSelect={() =>
                dialog.show(() => (
                  <DialogDeleteSession
                    title={title()}
                    onDelete={() => void props.sessions.session.remove(props.record.session)}
                  />
                ))
              }
            >
              {language.t("common.delete")}...
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}

/** The archived conversations: the same rows, where the menu restores instead of archiving. */
function HomeMobileArchived(props: { sessions: HomeSessionsController }) {
  const language = props.sessions.copy.language
  return (
    <Show
      when={!props.sessions.data.archivedLoading()}
      fallback={
        <p class="px-4 pt-10 text-center text-[15px] text-v2-text-text-muted">{language.t("common.loading")}</p>
      }
    >
      <Show
        when={props.sessions.data.archived().length > 0}
        fallback={
          <p class="px-4 pt-10 text-center text-[15px] leading-6 text-v2-text-text-muted">
            {props.sessions.data.archivedFailed()
              ? language.t("home.sessions.archived.failed")
              : language.t("home.sessions.archived.empty")}
          </p>
        }
      >
        <For each={props.sessions.data.archived()}>
          {(record) => <HomeMobileRow record={record} sessions={props.sessions} archived />}
        </For>
      </Show>
    </Show>
  )
}
