import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"

export const useComposerCommands = () => {
  const command = useCommand()
  const language = useLanguage()
  const local = useLocal()

  command.register("composer", () => [
    {
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      slash: "agent",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(1),
    },
  ])
}
