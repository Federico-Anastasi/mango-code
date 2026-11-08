import { type ComponentProps } from "solid-js"
import { MangoShape } from "../../components/logo"

// mango-code: the large wordmark of the new session. The colored mango, "mango" in the color of the
// text and "code" in the orange of the mark, kept subdued because the prompt field sits above.
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(-12 -38) scale(0.85)" opacity="0.9">
        <MangoShape />
      </g>
      <text
        x="160"
        y="104"
        font-family="Inter, sans-serif"
        font-weight="600"
        font-size="104"
        textLength="556"
        lengthAdjust="spacingAndGlyphs"
      >
        <tspan fill="currentColor" fill-opacity="0.28">
          mango{" "}
        </tspan>
        <tspan fill="#FFA61F" fill-opacity="0.75">
          code
        </tspan>
      </text>
    </svg>
  )
}
