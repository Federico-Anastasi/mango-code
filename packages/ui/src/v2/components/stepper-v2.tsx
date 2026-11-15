import { type ComponentProps, splitProps } from "solid-js"
import "./stepper-v2.css"

export interface StepperV2Props extends Omit<ComponentProps<"div">, "children" | "onChange"> {
  /** The value as it is shown («100%»). */
  value: string
  /** What the number is, for those who cannot see the group. */
  label: string
  decreaseLabel: string
  increaseLabel: string
  canDecrease?: boolean
  canIncrease?: boolean
  onDecrease: () => void
  onIncrease: () => void
}

/** A number changed by steps: «−», the value, «+». */
export function StepperV2(props: StepperV2Props) {
  const [split, rest] = splitProps(props, [
    "value",
    "label",
    "decreaseLabel",
    "increaseLabel",
    "canDecrease",
    "canIncrease",
    "onDecrease",
    "onIncrease",
    "class",
    "classList",
  ])
  return (
    <div
      {...rest}
      data-component="stepper-v2"
      role="group"
      aria-label={split.label}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <button
        type="button"
        data-slot="stepper-v2-button"
        aria-label={split.decreaseLabel}
        disabled={split.canDecrease === false}
        onClick={() => split.onDecrease()}
      >
        −
      </button>
      <span data-slot="stepper-v2-value" aria-live="polite">
        {split.value}
      </span>
      <button
        type="button"
        data-slot="stepper-v2-button"
        aria-label={split.increaseLabel}
        disabled={split.canIncrease === false}
        onClick={() => split.onIncrease()}
      >
        +
      </button>
    </div>
  )
}
