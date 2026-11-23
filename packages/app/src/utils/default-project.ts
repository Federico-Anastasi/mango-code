import type { Platform } from "@/context/platform"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { folderKey } from "@/utils/path-key"
import { displayName } from "@/pages/layout/helpers"

/**
 * The folder of the conversations that belong to no project: `<projects folder>\<name>`, made the first time it is
 * asked for and found as it is after that. Only inside the desktop app, which makes and knows the projects folder.
 */
export async function defaultProjectDirectory(
  platform: Required<Pick<Platform, "projectsFolder" | "createProjectFolder">>,
  name: string,
) {
  try {
    return await platform.createProjectFolder(name)
  } catch (cause) {
    if (mangoDesktopError(cause).code !== "exists") throw cause
    return `${await platform.projectsFolder()}\\${name}`
  }
}

/** The default folder as each language of the app names it: the folder keeps the name it was made with. */
export function defaultProjectFolders(projectsFolder: string | undefined, names: readonly string[]) {
  if (!projectsFolder) return []
  return names.map((name) => folderKey(`${projectsFolder}\\${name}`))
}

/** The project a conversation is shown under: its name in the list, or its folder's; none for the default folder. */
export function projectLabel(input: {
  directory: string
  project?: { name?: string; worktree: string }
  folders: readonly string[]
}) {
  if (input.folders.includes(folderKey(input.directory))) return
  return displayName(input.project ?? { worktree: input.directory })
}
