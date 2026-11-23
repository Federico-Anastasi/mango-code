import { createResource } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { defaultProjectDirectory, defaultProjectFolders } from "@/utils/default-project"
import { mangoDesktopError } from "@/utils/mango-desktop"
import { showToast } from "@/utils/toast"

/**
 * Where a conversation goes when there is no project at all: the folder `Conversazioni`, made in the projects folder
 * the first time. `undefined` outside the desktop app (it makes the folder); otherwise a function that gives the
 * folder, or tells why it could not make it and gives nothing.
 */
export function useDefaultProject() {
  const platform = usePlatform()
  const language = useLanguage()
  const { createProjectFolder, projectsFolder } = platform
  if (!createProjectFolder || !projectsFolder) return undefined
  return async () => {
    try {
      return await defaultProjectDirectory({ createProjectFolder, projectsFolder }, language.t("project.default.name"))
    } catch (cause) {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: mangoDesktopError(cause).message,
      })
    }
  }
}

/** The folders that hold the conversations with no project, as keys to compare with a conversation's folder. */
export function useDefaultProjectFolders() {
  const platform = usePlatform()
  const [folders] = createResource(async () => {
    const [en, it] = await Promise.all([import("@/i18n/en"), import("@/i18n/it")])
    // if the folder cannot be read, a conversation of the default folder is shown under that folder's name
    const root = await Promise.resolve(platform.projectsFolder?.()).catch(() => undefined)
    return defaultProjectFolders(root, [
      en.dict["project.default.name"],
      it.dict["project.default.name"],
    ])
  })
  return () => folders() ?? []
}
