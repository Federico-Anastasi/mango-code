import { type ComponentProps, splitProps, Show } from "solid-js"
import { PROJECT_FRUIT_ACCENT, projectFruitSrc, type ProjectFruit } from "./project-fruits"
import "./project-avatar-v2.css"

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined

function first(value: string) {
  if (!value) return ""
  if (!segmenter) return Array.from(value)[0] ?? ""
  return segmenter.segment(value)[Symbol.iterator]().next().value?.segment ?? Array.from(value)[0] ?? ""
}

export const PROJECT_AVATAR_VARIANTS = [
  "orange",
  "yellow",
  "cyan",
  "green",
  "red",
  "pink",
  "blue",
  "purple",
  "gray",
] as const

export type ProjectAvatarVariant = (typeof PROJECT_AVATAR_VARIANTS)[number]

// "outline" is a neutral, muted style (e.g. recently closed projects) and is not part of the color rotation.
export type ProjectAvatarStyle = ProjectAvatarVariant | "outline"

export interface ProjectAvatarProps extends ComponentProps<"div"> {
  fallback: string
  src?: string
  variant?: ProjectAvatarStyle
  /** Fruit instead of the initial: the tile takes the fruit color. With `src` the image wins. */
  fruit?: ProjectFruit
  unread?: boolean
}

export function ProjectAvatar(props: ProjectAvatarProps) {
  const [split, rest] = splitProps(props, ["fallback", "src", "variant", "fruit", "unread", "class", "classList", "style"])
  return (
    <div
      {...rest}
      data-component="project-avatar-v2"
      data-unread={split.unread ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      style={typeof split.style === "object" ? split.style : undefined}
    >
      <div
        data-slot="project-avatar-surface"
        data-variant={split.variant ?? "gray"}
        data-has-image={split.src ? "" : undefined}
        data-fruit={!split.src && split.fruit ? split.fruit : undefined}
        style={!split.src && split.fruit ? { "--project-fruit-accent": PROJECT_FRUIT_ACCENT[split.fruit] } : undefined}
      >
        <Show
          when={split.src}
          fallback={
            <Show when={split.fruit} fallback={first(split.fallback)}>
              {(fruit) => <img src={projectFruitSrc(fruit())} alt="" draggable={false} data-slot="project-avatar-fruit" />}
            </Show>
          }
        >
          {(value) => <img src={value()} draggable={false} data-slot="project-avatar-image" />}
        </Show>
      </div>
      <Show when={split.unread}>
        <span data-slot="project-avatar-unread-dot" aria-hidden="true" />
      </Show>
    </div>
  )
}
