import type { Platform } from "@/context/platform"
import { mangoDesktopError } from "@/utils/mango-desktop"

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
