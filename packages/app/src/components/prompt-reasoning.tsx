import { Popover } from "@kobalte/core/popover"
import { createSignal, For } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import "./prompt-reasoning.css"

/**
 * How much the model thinks, beside the model's name: closed it is the gauge and the current value; clicked, it opens
 * above the bar the levels the model offers, and closes with a level, Escape or a click elsewhere.
 */
export function PromptReasoning(props: {
  levels: readonly string[]
  value: string
  label: string
  text: (level: string) => string
  onChange: (level: string) => void
  onClose?: () => void
}) {
  const [open, setOpen] = createSignal(false)
  let content: HTMLDivElement | undefined
  // opened with the keyboard, focus goes in to the levels; with the pointer it stays out, and no ring is drawn on one
  let keyboard = false
  const toggle = (next: boolean) => {
    setOpen(next)
    if (!next) props.onClose?.()
  }

  return (
    <Popover open={open()} onOpenChange={toggle} placement="top-start" gutter={6} flip={false} modal={false}>
      <TooltipV2 placement="top" gutter={4} value={props.label}>
        <Popover.Trigger
          data-action="prompt-reasoning"
          aria-label={props.label}
          onPointerDown={() => (keyboard = false)}
          onKeyDown={() => (keyboard = true)}
        >
          <Icon name="gauge" />
          <span>{props.text(props.value)}</span>
        </Popover.Trigger>
      </TooltipV2>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          data-component="prompt-reasoning-control"
          onOpenAutoFocus={(event) => {
            if (keyboard) return
            event.preventDefault()
            content?.focus()
          }}
        >
          <SegmentedControlV2
            aria-label={props.label}
            value={props.value}
            onChange={(level) => level && props.onChange(level)}
          >
            <For each={props.levels}>
              {(level) => (
                <SegmentedControlItemV2 value={level} data-level={level} onClick={() => toggle(false)}>
                  {props.text(level)}
                </SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
