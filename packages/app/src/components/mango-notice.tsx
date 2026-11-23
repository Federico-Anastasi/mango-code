import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"

/** The engine's notice above the box: the line of the status, in the amber of a warning, that the user can close. */
export function MangoNotice(props: { text: string; closeLabel: string; onClose: () => void }) {
  return (
    <div
      role="status"
      data-component="mango-notice"
      data-kind="notice"
      class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 text-center text-[12px] leading-4 text-[var(--mango-action-text)]"
    >
      <span>{props.text}</span>
      <ButtonV2 size="small" variant="ghost" data-action="mango-notice-dismiss" onClick={props.onClose}>
        {props.closeLabel}
      </ButtonV2>
    </div>
  )
}
