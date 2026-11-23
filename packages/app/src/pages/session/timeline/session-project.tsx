import { Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"

/** The head of a conversation: the project it is in, where the title was (the title is in the tab). */
export function SessionProject(props: { name?: string; none: string }) {
  return (
    <div
      data-slot="session-project"
      data-empty={props.name ? undefined : ""}
      title={props.name}
      class="flex min-w-0 items-center gap-2 px-2 py-1 text-[13px] leading-4 tracking-[-0.04px]"
    >
      <Show
        when={props.name}
        fallback={<span class="truncate font-normal text-v2-text-text-muted">{props.none}</span>}
      >
        {(name) => (
          <>
            <Icon name="folder" class="shrink-0 text-v2-text-text-muted" />
            <span data-slot="session-project-name" class="truncate font-medium text-v2-text-text-base">
              {name()}
            </span>
          </>
        )}
      </Show>
    </div>
  )
}
