import { type ComponentProps, splitProps } from "solid-js"
import "./progress-bar-v2.css"

export interface ProgressBarV2Props extends Omit<ComponentProps<"div">, "children"> {
  /** How far the work is, from 0 to 100. */
  value: number
  /** What the bar is about, for those who cannot see it. */
  label: string
}

/** A job whose progress is known: a 6 px pill, an amber gradient filling the track. */
export function ProgressBarV2(props: ProgressBarV2Props) {
  const [split, rest] = splitProps(props, ["value", "label", "class", "classList"])
  const share = () => Math.min(100, Math.max(0, split.value))
  return (
    <div
      {...rest}
      data-component="progress-bar-v2"
      role="progressbar"
      aria-label={split.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share())}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <span data-slot="progress-bar-v2-fill" style={{ width: `${share()}%` }} />
    </div>
  )
}
