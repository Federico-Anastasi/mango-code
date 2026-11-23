import { Show } from "solid-js"

/** What the hint of a conversation's tab says: the project, quieter, and the whole title. */
export function TabHint(props: { project?: string; title?: string }) {
  return (
    <>
      <Show when={props.project}>
        <span data-slot="project" class="max-w-[180px] shrink-0 truncate text-v2-text-text-muted">
          {props.project}
        </span>
        <span aria-hidden="true">·</span>
      </Show>
      <span data-slot="title" class="[overflow-wrap:anywhere]">
        {props.title}
      </span>
    </>
  )
}
