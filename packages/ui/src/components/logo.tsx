import { type ComponentProps, createUniqueId } from "solid-js"

// mango-code: the mark is a mango made of lines of code, which start at the left edge and
// end at different lengths (same drawing as app/src-tauri/icons/mango.svg in the mango-code repo). Gradient and
// clip have an id per instance: several marks on the same page do not clash.
const MANGO_BODY =
  "M 96 52 C 142 40 182 78 176 126 C 171 166 134 190 94 184 C 66 180 44 172 24 150 C 34 150 42 144 44 132 C 46 92 62 60 96 52 Z"
const ROW_ENDS = [150, 182, 128, 170, 182, 112, 160, 182, 140, 120, 182, 150]

export const MangoShape = () => {
  const id = createUniqueId()
  return (
    <>
      <defs>
        <linearGradient id={`mango-skin-${id}`} gradientUnits="userSpaceOnUse" x1="47" y1="59" x2="155" y2="178">
          <stop offset="0" stop-color="#FFD84A" />
          <stop offset="0.5" stop-color="#FFA61F" />
          <stop offset="1" stop-color="#F0532B" />
        </linearGradient>
        <clipPath id={`mango-clip-${id}`}>
          <path d={MANGO_BODY} />
        </clipPath>
      </defs>
      <g clip-path={`url(#mango-clip-${id})`} fill={`url(#mango-skin-${id})`}>
        {ROW_ENDS.map((end, i) => (
          <rect x="0" y={44 + i * 13} width={end} height="9" rx="4.5" />
        ))}
      </g>
    </>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="10 26 180 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MangoShape />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="10 26 180 180"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MangoShape />
    </svg>
  )
}

// Wordmark: Inter 600, tight letter spacing, "code" in the orange of the mark (like "mangOS").
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 140"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g transform="translate(0 -14) scale(0.8)">
        <MangoShape />
      </g>
      <text
        x="168"
        y="112"
        font-family="Inter, sans-serif"
        font-weight="600"
        font-size="96"
        textLength="452"
        lengthAdjust="spacingAndGlyphs"
        fill="var(--text-strong)"
      >
        mango <tspan fill="#FFA61F">code</tspan>
      </text>
    </svg>
  )
}
