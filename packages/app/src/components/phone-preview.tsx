import { Match, Show, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "@/context/language"
import { phonePreview, previewFailed } from "@/utils/phone-preview"

/**
 * From a phone, the page the browser panel of the computer is showing, full screen over the conversation. The page comes from
 * the phone port's second port (`utils/phone-preview.ts`); the bar over it has the way back to the conversation. A picture or
 * a PDF of the project takes the same place, shown from the copy the phone fetched.
 */
export function PhonePreview() {
  const language = useLanguage()
  // The panel may have moved on since: the page is asked again, not just the frame.
  const reload = () => phonePreview.open().catch(previewFailed(language.t("preview.phone.failed")))

  return (
    <Show when={phonePreview.view()} keyed>
      {(view) => (
        <div
          data-component="phone-preview"
          class="fixed inset-0 z-50 flex flex-col bg-v2-background-bg-deep pt-[var(--safe-top)] pb-[var(--safe-bottom)]"
        >
          <div class="flex h-12 shrink-0 items-center gap-0.5 px-1">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              class="!size-11 shrink-0"
              icon={<Icon name="chevron-left" />}
              onClick={phonePreview.close}
              aria-label={language.t("preview.phone.back")}
              data-action="preview-back"
            />
            <h1 class="min-w-0 flex-1 truncate px-1 text-[16px] leading-6 text-v2-text-text-base [font-weight:530]">
              {view.title || language.t("preview.title")}
            </h1>
            <Show when={!view.kind}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                class="!size-11 shrink-0"
                icon={<Icon name="reload" />}
                onClick={reload}
                aria-label={language.t("preview.reload")}
                data-action="preview-reload"
              />
            </Show>
          </div>
          <Switch>
            <Match when={view.kind === "image"}>
              {/* An image element draws an SVG as a picture: its scripts never run. */}
              <img
                src={view.src}
                alt={view.title}
                class="min-h-0 w-full flex-1 object-contain"
                data-component="phone-preview-image"
              />
            </Match>
            <Match when={view.kind === "pdf"}>
              <iframe src={view.src} title={view.title} class="min-h-0 w-full flex-1 border-0 bg-white" />
            </Match>
            <Match when={true}>
              <iframe
                // The page is the computer's own and can run scripts, but it cannot take the whole app away from the phone.
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                src={view.src}
                title={view.title || language.t("preview.title")}
                class="min-h-0 w-full flex-1 border-0 bg-white"
              />
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  )
}
