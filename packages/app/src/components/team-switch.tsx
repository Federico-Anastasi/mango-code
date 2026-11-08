// mango-code: the "Team" switch next to the model. The Team is opencode's `team` agent (the manager, a cloud
// model): turning it on gives the conversation to the manager, turning it off gives it back to the local model. Without the
// OpenRouter key it does not turn on, and the button leads to the "Team" page of the settings.
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { createResource, Show } from "solid-js"
import { DialogSettings } from "@/components/settings-v2"
import type { PromptInputProps } from "@/components/prompt-input/contracts"
import { useLanguage } from "@/context/language"

/** The name of the manager's agent: the same as `agent-cfg` (team.rs, `AGENT`). */
const TEAM_AGENT = "team"

export function TeamSwitch(props: { agents: PromptInputProps["controls"]["agents"] }) {
  const language = useLanguage()
  const dialog = useDialog()
  const team = () => window.__MANGO_DESKTOP__?.team
  const [info] = createResource(async () => await team()?.info())

  return (
    <Show when={info()}>
      {(current) => (
        <div data-action="prompt-team" class="flex h-7 items-center px-2 text-[13px]">
          <Show
            when={current().key && props.agents.options.includes(TEAM_AGENT)}
            fallback={
              <ButtonV2
                variant="ghost-muted"
                size="normal"
                title={language.t("prompt.team.noKey")}
                onClick={() => dialog.show(() => <DialogSettings defaultValue="team" />)}
              >
                {language.t("prompt.team")}
              </ButtonV2>
            }
          >
            <Switch
              checked={props.agents.current === TEAM_AGENT}
              onChange={(checked) => props.agents.select(checked ? TEAM_AGENT : "build")}
            >
              {language.t("prompt.team")}
            </Switch>
          </Show>
        </div>
      )}
    </Show>
  )
}
