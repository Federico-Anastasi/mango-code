// mango-code: the messages of a conversation that wait for the model, as bubbles at the end of the
// conversation, in the order they were sent. Each has an X that takes it back into the box, off while it is being sent;
// when it did not leave after its tries it says so, with «Retry». Without bubbles nothing takes room.
import { createEffect, For, on, onCleanup, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { useMango } from "@/context/mango"
import { pendingText } from "@/utils/mango-pending"
import { canSend } from "@/utils/mango-state"

/** How much of a message the X names: «Riordina le fatture di…». */
const NAMED = 40

/**
 * `onChange`: the bubbles changed (one more, «Non è partito» with Retry): the conversation goes to its end if it was
 * there, so that what changed is seen.
 */
export function MangoPendingBubbles(props: {
  sessionID: string | undefined
  centered?: boolean
  onChange: () => void
}) {
  const mango = useMango()
  const language = useLanguage()
  const items = () => (props.sessionID ? mango.pending.waiting(props.sessionID) : [])
  const sending = () => !!props.sessionID && mango.pending.sending(props.sessionID)
  const stuck = () => !!props.sessionID && mango.pending.stuck(props.sessionID)
  const retry = () => {
    if (!props.sessionID) return
    mango.pending.retry(props.sessionID)
    void mango.refresh()
  }
  // after the page has the new bubbles: the end of the conversation is below them. Not at the start: the conversation
  // that opens takes care of its own end.
  let frame: number | undefined
  createEffect(
    on(
      [() => items().length, stuck],
      () => {
        if (frame !== undefined) cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          frame = undefined
          props.onChange()
        })
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return (
    <Show when={items().length > 0}>
      <div
        data-component="mango-pending"
        class="flex w-full flex-col items-end gap-2 px-4 pb-4 md:px-5"
        classList={{ "md:max-w-200 2xl:max-w-[1000px] mx-auto": props.centered }}
      >
        <For each={items()}>
          {(item) => {
            const text = () => pendingText(item.draft)
            const named = () => (text().length > NAMED ? `${text().slice(0, NAMED).trimEnd()}…` : text())
            return (
              <div data-slot="mango-pending-item" class="flex max-w-[85%] items-start gap-1">
                <div class="whitespace-pre-wrap rounded-lg bg-v2-background-bg-layer-01 px-3 py-2 text-[14px] leading-5 text-v2-text-text-base">
                  {text()}
                </div>
                <IconButtonV2
                  type="button"
                  variant="ghost-muted"
                  size="small"
                  icon={<Icon name="xmark-small" />}
                  aria-label={language.t("mango.pending.restore", { message: named() })}
                  data-action="mango-pending-restore"
                  disabled={sending()}
                  onClick={() => mango.pending.restore(item)}
                />
              </div>
            )
          }}
        </For>
        <Show
          when={stuck()}
          fallback={
            <span data-slot="mango-pending-note" class="pr-8 text-[12px] leading-4 text-v2-text-text-faint">
              {language.t(sending() || canSend(mango.state()) ? "mango.pending.sending" : "mango.pending.waiting")}
            </span>
          }
        >
          <div
            data-slot="mango-pending-note"
            class="flex items-center gap-2 pr-8 text-[12px] leading-4 text-v2-text-text-muted"
          >
            <span>{language.t("mango.pending.notSent")}</span>
            <ButtonV2 size="small" variant="ghost" data-action="mango-pending-retry" onClick={retry}>
              {language.t("mango.action.retry")}
            </ButtonV2>
          </div>
        </Show>
      </div>
    </Show>
  )
}
