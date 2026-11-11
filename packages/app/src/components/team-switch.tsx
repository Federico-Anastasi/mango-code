// mango-code: the "Team" switch next to the model. The Team is opencode's `team` agent (the manager, a cloud
// model): turning it on gives the conversation to the manager, turning it off gives it back to the local model. The
// switch is there only once the Team is set up in the settings (OpenRouter key saved).
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { createResource, Show } from "solid-js"
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { useLanguage } from "@/context/language"
import { TEAM_AGENT, teamIsOn } from "@/utils/team-switch"

export function TeamSwitch(props: { agents: PromptInputProps["controls"]["agents"] }) {
  const language = useLanguage()
  const team = () => window.__MANGO_DESKTOP__?.team
  const [info] = createResource(async () => await team()?.info())

  return (
    <Show when={teamIsOn(info(), props.agents.options)}>
      <div data-action="prompt-team" class="flex h-7 items-center px-2 text-[13px]">
        <Switch
          checked={props.agents.current === TEAM_AGENT}
          onChange={(checked) => props.agents.select(checked ? TEAM_AGENT : "build")}
        >
          {language.t("prompt.team")}
        </Switch>
      </div>
    </Show>
  )
}
