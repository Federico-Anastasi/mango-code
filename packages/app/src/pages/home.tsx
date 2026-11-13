import { createEffect, Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { isDirectoryMissingError, reportMissingDirectory } from "@/utils/missing-directory"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"
import { HomeMobile } from "./home/home-mobile"
import { MangoHomePanel } from "@/components/mango-home"

export function NewHome() {
  const home = createHomeController()
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const phone = createMediaQuery("(max-width: 767px)")

  // mango-code: `?project=<folder>` opens that folder as a project (the app passes it when a folder is
  // opened from File Explorer), so there is no need to browse the disk from the picker. The parameter disappears from the URL.
  // On Windows the server stores sessions and projects with the native path (C:\...): with the / slashes the page
  // kept the project under another key and lost the session at the first refresh.
  const raw = new URLSearchParams(location.search).get("project")
  const requested = raw && /^[A-Za-z]:[\\/]/.test(raw) ? raw.replace(/\//g, "\\") : raw
  let opened = false
  createEffect(() => {
    const conn = home.server.focused()
    if (opened || !requested || !conn) return
    opened = true
    const params = new URLSearchParams(location.search)
    params.delete("project")
    history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
    home.project.add(conn, [requested])
  })

  // mango-code: projects whose folder no longer exists (deleted or moved) remove themselves.
  // The server answers 404 DirectoryNotFound: it is reported, and layout-new removes the project, warning once.
  const checked = new Set<string>()
  createEffect(() => {
    const conn = home.server.focused()
    if (!conn) return
    const ctx = home.server.context(conn)
    for (const project of home.project.forServer(conn)) {
      const directory = project.worktree
      if (!directory || checked.has(directory)) continue
      checked.add(directory)
      // projects saved by a previous version with the Windows path with / slashes (see above): they are
      // replaced with the native path, otherwise their sessions are lost at the first refresh
      if (/^[A-Za-z]:\//.test(directory)) {
        const native = directory.replace(/\//g, "\\")
        ctx.projects.close(directory)
        ctx.projects.open(native)
        if (home.selection.value().directory === directory)
          home.selection.set({ ...home.selection.value(), directory: native })
        continue
      }
      // the web UI client is created with throwOnError: a 404 arrives as an exception (see missing-directory.ts)
      void ctx.sdk.client.file.list({ path: ".", directory }).catch((err: unknown) => {
        if (isDirectoryMissingError(err)) reportMissingDirectory(directory)
      })
    }
  })
  // mango-code: the first project from the Home's model panel, on the server in view (see components/mango-home.tsx).
  const newProject =
    projects.project.create &&
    (() => {
      const conn = home.server.focused()
      if (conn) projects.project.create?.(conn)
    })
  const openFolder = () => {
    const conn = home.server.focused()
    if (conn) projects.project.choose(conn)
  }
  return (
    <div
      class={`
        relative m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] max-md:m-0 max-md:rounded-none
        bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] max-md:shadow-none
      `}
    >
      <Show
        when={!phone()}
        fallback={
          <MangoHomePanel onNewProject={newProject} onOpenFolder={openFolder}>
            <HomeMobile projects={projects} sessions={sessions} />
          </MangoHomePanel>
        }
      >
        <ScrollView
          class="absolute inset-0 [container-type:size]"
          thumbContainer={scroll.viewport.thumbTrack}
          thumbHoverTarget={scroll.viewport.hoverTarget}
          viewportRef={scroll.viewport.setViewport}
          onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
          onWheel={scroll.viewport.containOuterWheel}
        >
          <div
            class={`
            mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3
            lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6
          `}
          >
            <HomeProjects projects={projects} scroll={scroll} />
            <MangoHomePanel onNewProject={newProject} onOpenFolder={openFolder}>
              <HomeSessions sessions={sessions} search={search} scroll={scroll} />
            </MangoHomePanel>
            <HomeUtilityNav
              class="flex lg:hidden"
              onOpenSettings={projects.utility.settings}
              onOpenHelp={projects.utility.help}
              language={projects.copy.language}
            />
          </div>
        </ScrollView>
      </Show>
    </div>
  )
}
