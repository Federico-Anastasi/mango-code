import { useProjectFolders } from "@/components/dialog-broad-folder"
import { useGlobal } from "@/context/global"
import { type HomeProjectSelection, useLayout } from "@/context/layout"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import { useDefaultProject } from "@/hooks/use-default-project"
import { toggleHomeProjectSelection } from "@/pages/layout/helpers"
import { isDirectoryMissingError, reportMissingDirectory } from "@/utils/missing-directory"
import { createEffect, createMemo } from "solid-js"

export function createHomeController() {
  const sync = useServerSync()
  const layout = useLayout()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const projectFolders = useProjectFolders()
  const defaultProject = useDefaultProject()
  const selection = layout.home.selection
  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const recentlyClosed = createMemo(
    () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
  )
  const homedir = createMemo(() => focusedSync().data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  // The project folder may have disappeared from the disk: this is discovered before opening a conversation in it.
  function directoryMissing(conn: ServerConnection.Any, directory: string) {
    return global
      .ensureServerCtx(conn)
      .sdk.client.file.list({ path: ".", directory })
      .then(
        () => false,
        (err: unknown) => {
          if (!isDirectoryMissingError(err)) return false
          reportMissingDirectory(directory)
          return true
        },
      )
  }

  async function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    if (await directoryMissing(conn, directory)) return
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: global.servers.list,
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      // inside the app a conversation can start with no project at all: it goes to the default folder
      canStartSession: createMemo(() => !!newSessionProject() || !!defaultProject),
      forServer: (conn: ServerConnection.Any) => global.ensureServerCtx(conn).projects.list(),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)
        if (global.servers.health[key]?.healthy === false) return
        if (
          !global
            .ensureServerCtx(conn)
            .projects.list()
            .some((project) => project.worktree === directory)
        )
          return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
        void directoryMissing(conn, directory)
      },
      add: async (conn: ServerConnection.Any, chosen: string[]) => {
        const directories = await projectFolders(conn, chosen)
        const directory = directories[0]
        if (!directory) return
        const ctx = global.ensureServerCtx(conn)
        directories.forEach((item) => {
          if (ctx.projects.list().some((project) => project.worktree === item)) return
          const location = { directory: item }
          void ctx.sdk.api.file
            .list({ path: ".", location })
            .then(async (files) => {
              if (files.data.length > 0) return ctx.sdk.api.project.current({ location })
              const result = await ctx.sdk.client.project.initGit({ directory: item })
              return result.data ?? ctx.sdk.api.project.current({ location })
            })
            .then((project) => ctx.sync.child(item, { bootstrap: false })[1]("project", project.id))
            .catch(() => undefined)
          ctx.projects.open(item)
        })
        ctx.projects.touch(directory)
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: async () => {
        const conn = focusedServer()
        if (!conn) return
        const project = newSessionProject()
        if (project) return openProjectNewSession(conn, project.worktree)
        const directory = await defaultProject?.()
        if (directory) return openProjectNewSession(conn, directory)
      },
      openProjectNewSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
