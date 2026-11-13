import { Show } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"

/** The bar of the search in the conversation: the text, where we are among the results, previous, next, close. */
export function ConversationFindBar(props: {
  query: string
  index: number
  count: number
  /** Older messages are not loaded yet: the count says it covers only the loaded part. */
  partial: boolean
  setInput: (el: HTMLInputElement) => void
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onMove: (step: 1 | -1) => void
  onClose: () => void
}) {
  const language = useLanguage()

  return (
    <div
      data-component="conversation-find"
      role="search"
      aria-label={language.t("session.find.open")}
      class="pointer-events-auto flex h-9 w-[min(420px,100%)] items-center gap-1 rounded-lg py-1 pl-3 pr-1 text-v2-icon-icon-muted"
      style={{
        background: "var(--v2-background-bg-layer-01)",
        "box-shadow": "var(--v2-elevation-raised)",
      }}
    >
      <IconV2 name="magnifying-glass" />
      <input
        ref={props.setInput}
        data-slot="conversation-find-input"
        class="min-w-0 flex-1 border-0 bg-transparent px-1 outline-0 text-14-regular text-v2-text-text-base placeholder:text-v2-text-text-faint"
        value={props.query}
        placeholder={language.t("session.find.placeholder")}
        aria-label={language.t("session.find.placeholder")}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={props.onKeyDown}
      />
      {/* Always in the page, so that a screen reader hears every change of the count. */}
      <span
        data-slot="conversation-find-count"
        role="status"
        aria-live="polite"
        class="shrink-0 px-1 text-12-regular text-v2-text-text-faint tabular-nums"
      >
        <Show when={props.query.trim()}>
          {props.count
            ? language.t(props.partial ? "session.find.count.partial" : "session.find.count", {
                current: props.index + 1,
                total: props.count,
              })
            : language.t(props.partial ? "session.find.none.partial" : "session.find.none")}
        </Show>
      </span>
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="small"
        disabled={props.count === 0}
        aria-label={language.t("session.find.previous")}
        onClick={() => props.onMove(-1)}
        icon={<IconV2 name="chevron-down" class="rotate-180" />}
      />
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="small"
        disabled={props.count === 0}
        aria-label={language.t("session.find.next")}
        onClick={() => props.onMove(1)}
        icon={<IconV2 name="chevron-down" />}
      />
      <IconButtonV2
        type="button"
        variant="ghost-muted"
        size="small"
        aria-label={language.t("session.find.close")}
        onClick={props.onClose}
        icon={<IconV2 name="xmark-small" />}
      />
    </div>
  )
}
