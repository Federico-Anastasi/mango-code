import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import type { TeamNoticeKind } from "./team-notice"

/** The line of what the dev or an agent wrote to the manager: the beginning after the words, the whole message when it is open. */
export function TeamNoticeLine(props: {
  kind: TeamNoticeKind
  label: string
  excerpt: string
  text: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <div data-component="team-notice" data-kind={props.kind}>
      <Collapsible open={props.open} onOpenChange={props.onOpenChange} variant="ghost" class="team-notice-collapsible">
        <Collapsible.Trigger>
          <div data-component="compaction-part">
            <div data-slot="compaction-part-divider">
              <span data-slot="compaction-part-line" />
              <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
                <span data-slot="team-notice-label">{props.label}</span>
                <span data-slot="team-notice-excerpt">{props.excerpt}</span>
              </span>
              <Collapsible.Arrow />
              <span data-slot="compaction-part-line" />
            </div>
          </div>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div data-slot="team-notice-body" class="text-13-regular text-text-weak">
            <Markdown text={props.text} />
          </div>
        </Collapsible.Content>
      </Collapsible>
    </div>
  )
}
