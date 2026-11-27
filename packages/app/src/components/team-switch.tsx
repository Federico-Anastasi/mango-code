// mango-code: the "Team" switch next to the model. The Team is opencode's `team` agent (the manager, a cloud
// model): turning it on gives the conversation to the manager, turning it off gives it back to the local model. The
// switch is there only once the Team is set up in the settings (OpenRouter key saved). Turning it off stops what the
// Team started in the conversation: the manager's answer, the dev and the agents.
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { createResource, Show } from "solid-js"
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { useLanguage } from "@/context/language"
import { TEAM_AGENT, teamIsOn } from "@/utils/team-switch"
import { showToast } from "@/utils/toast"

export function TeamSwitch(props: { agents: PromptInputProps["controls"]["agents"]; stop: () => Promise<unknown> }) {
  const language = useLanguage()
  const team = () => window.__MANGO_DESKTOP__?.team
  const [info] = createResource(async () => await team()?.info())

  const change = async (checked: boolean) => {
    props.agents.select(checked ? TEAM_AGENT : "build")
    if (checked) return
    try {
      await props.stop()
    } catch (error) {
      showToast({ variant: "error", title: language.t("prompt.team.stopFailed"), description: String((error as Error)?.message ?? error) })
    }
  }

  return (
    <Show when={!info.error && teamIsOn(info(), props.agents.options)}>
      <div data-action="prompt-team" class="flex h-7 items-center px-2 text-[13px]">
        <Switch checked={props.agents.current === TEAM_AGENT} onChange={change}>
          {language.t("prompt.team")}
        </Switch>
      </div>
    </Show>
  )
}
