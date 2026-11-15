// @ts-nocheck
import { createSignal } from "solid-js"
import { StepperV2 } from "./stepper-v2"

const docs = `### Overview
A number changed by steps: minus, the value, plus.

### API
- \`value\`: the text shown between the buttons.
- \`label\`, \`decreaseLabel\`, \`increaseLabel\`: names for assistive technology.
- \`onDecrease\`, \`onIncrease\`, and \`canDecrease\` / \`canIncrease\` to disable an end.
`

export default {
  title: "UI V2/Stepper",
  id: "components-stepper-v2",
  component: StepperV2,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: docs } } },
}

export const Basic = {
  render: () => {
    const [value, setValue] = createSignal(100)
    return (
      <StepperV2
        label="Size"
        value={`${value()}%`}
        decreaseLabel="Smaller"
        increaseLabel="Larger"
        canDecrease={value() > 50}
        canIncrease={value() < 200}
        onDecrease={() => setValue((current) => current - 10)}
        onIncrease={() => setValue((current) => current + 10)}
      />
    )
  },
}
