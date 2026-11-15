// @ts-nocheck
import { ProgressBarV2 } from "./progress-bar-v2"

const docs = `### Overview
A job whose progress is known.

### API
- \`value\`: 0 to 100.
- \`label\`: what the bar is about, for assistive technology.

### Theming/tokens
- 6px pill; the track is the raised ground, the fill the amber gradient of the main button.
`

export default {
  title: "UI V2/Progress Bar",
  id: "components-progress-bar-v2",
  component: ProgressBarV2,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: docs } } },
  args: { value: 61, label: "Download" },
}

export const Basic = {}
