// mango-code: the head of a section of the settings page: its title, the line that says what it is for, and what the
// section puts beside them (a choice that applies to the whole section).
import { type Component, type JSX, Show } from "solid-js"

export const PaneHeader: Component<{ title: string; lead?: string; children?: JSX.Element }> = (props) => (
  <div class="settings-page-pane-header">
    <div class="settings-page-pane-heading">
      <h2 class="settings-page-pane-title">{props.title}</h2>
      <Show when={props.lead}>
        <p class="settings-page-pane-description">{props.lead}</p>
      </Show>
    </div>
    {props.children}
  </div>
)
