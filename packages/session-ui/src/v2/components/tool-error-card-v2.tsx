import { Collapsible } from "@kobalte/core/collapsible"
import { type ComponentProps, type JSX, Show, createMemo, splitProps } from "solid-js"
import "./tool-error-card-v2.css"

function BanIcon() {
  return (
    <svg
      data-slot="tool-error-card-ban"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M4.929 4.929 19.07 19.071" />
    </svg>
  )
}

/** duo-progress-25: faint track ring + ~25% solid arc (Figma OpenCode DS) */
function LoaderIcon() {
  const r = 5.9
  return (
    <svg
      data-slot="tool-error-card-loader"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g transform="translate(8 8)">
        <circle
          r={r}
          fill="none"
          stroke="var(--v2-icon-icon-base)"
          stroke-width="1"
          stroke-opacity="0.3"
          transform="rotate(-90)"
        />
        <circle
          r={r}
          fill="none"
          stroke="var(--v2-icon-icon-base)"
          stroke-width="1"
          pathLength="100"
          stroke-dasharray="25 75"
          transform="rotate(-90)"
        />
      </g>
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg
      data-slot="tool-error-card-chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

export interface ToolErrorCardV2Props extends Omit<ComponentProps<"div">, "children" | "title"> {
  title: JSX.Element | string
  subtitle: JSX.Element | string
  suffix?: JSX.Element | string
  loading?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** When set, subtitle renders as a link (clicks do not toggle expand). */
  subtitleHref?: string
}

export function ToolErrorCardV2(props: ToolErrorCardV2Props) {
  const [local, rest] = splitProps(props, [
    "title",
    "subtitle",
    "suffix",
    "loading",
    "open",
    "defaultOpen",
    "onOpenChange",
    "subtitleHref",
    "class",
    "classList",
  ])

  const hasSuffix = createMemo(() => {
    const s = local.suffix
    if (s == null) return false
    if (typeof s === "string") return s.length > 0
    return true
  })

  return (
    <Collapsible
      {...rest}
      data-component="tool-error-card"
      open={local.open}
      defaultOpen={local.defaultOpen}
      onOpenChange={local.onOpenChange}
      disabled={!hasSuffix()}
      aria-busy={local.loading ? true : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Collapsible.Trigger as="div" role="button" data-slot="tool-error-card-trigger">
        <span data-slot="tool-error-card-icon-wrap">
          <Show when={local.loading} fallback={<BanIcon />}>
            <LoaderIcon />
          </Show>
        </span>
        <div data-slot="tool-error-card-main">
          <div data-slot="tool-error-card-labels">
            <span data-slot="tool-error-card-title">{local.title}</span>
            <span data-slot="tool-error-card-sep" aria-hidden="true">
              ·
            </span>
            <Show
              when={local.subtitleHref}
              fallback={<span data-slot="tool-error-card-subtitle">{local.subtitle}</span>}
            >
              <a
                data-slot="tool-error-card-subtitle"
                href={local.subtitleHref!}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {local.subtitle}
              </a>
            </Show>
            <Show when={hasSuffix()}>
              <span data-slot="tool-error-card-chevron-wrap">
                <ChevronIcon />
              </span>
            </Show>
          </div>
        </div>
      </Collapsible.Trigger>
      <Show when={hasSuffix()}>
        <Collapsible.Content data-slot="tool-error-card-content">
          <div data-slot="tool-error-card-suffix">{local.suffix}</div>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}
