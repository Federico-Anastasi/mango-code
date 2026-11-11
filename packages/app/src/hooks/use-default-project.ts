import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { defaultProjectDirectory } from "@/utils/default-project"
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
