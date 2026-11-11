// Hand-drawn fruits for the project icons: same language as the mango of the mark
// (flat shapes, light diagonal gradient, a pale highlight). Original drawings.
// Each fruit is a standalone SVG in a 64x64 square, returned as a string and as a data URI,
// so it can be used in an <img> without gradient ids clashing on the page.

export const PROJECT_FRUITS = [
  "mango",
  "cherry",
  "lemon",
  "kiwi",
  "grapes",
  "pear",
  "strawberry",
  "watermelon",
  "pineapple",
  "peach",
  "coconut",
  "fig",
  "plum",
  "orange",
  "apple",
  "banana",
] as const

export type ProjectFruit = (typeof PROJECT_FRUITS)[number]

/** Prefix with which the fruit choice is saved in the color field of the project. */
export const PROJECT_FRUIT_PREFIX = "fruit:"

export function isProjectFruit(value: unknown): value is ProjectFruit {
  return typeof value === "string" && (PROJECT_FRUITS as readonly string[]).includes(value)
}

/** Accent color of the fruit: tints the tile background and its border. */
export const PROJECT_FRUIT_ACCENT: Record<ProjectFruit, string> = {
  mango: "#FFA61F",
  cherry: "#C8203E",
  lemon: "#F2D21B",
  kiwi: "#8DC63F",
  grapes: "#9B5DE5",
  pear: "#C3D63A",
  strawberry: "#FF4D6D",
  watermelon: "#1FA05A",
  pineapple: "#F2B01E",
  peach: "#FF8F6B",
  coconut: "#A8744C",
  fig: "#B03A6A",
  plum: "#5B4BC4",
  orange: "#FF7A1A",
  apple: "#E5322D",
  banana: "#FFD23F",
}

type Stops = readonly [string, string, string]

const GREEN: Stops = ["#9BE35F", "#3FAE4D", "#1F7A3A"]
const BROWN = "#7A4B2A"

const grad = (id: string, [a, b, c]: Stops) =>
  `<linearGradient id="${id}" x1="0.15" y1="0.1" x2="0.85" y2="0.95"><stop offset="0" stop-color="${a}"/><stop offset="0.5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`

const radial = (id: string, [a, b, c]: Stops) =>
  `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${a}"/><stop offset="0.6" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient>`

const shine = (d: string, w = 3.5, color = "#FFF3B0", opacity = 0.75) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" opacity="${opacity}"/>`

const leaf = (x: number, y: number, rot: number, scale = 1) =>
  `<path transform="translate(${x} ${y}) rotate(${rot}) scale(${scale})" d="M0 0 C 5 -9 17 -9 24 -2 C 17 7 5 7 0 0 Z" fill="url(#lf)"/>`

const stem = (d: string, w = 2.8, color = BROWN) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`

const svg = (inner: string, viewBox = "0 0 64 64") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><defs>${grad("lf", GREEN)}</defs>${inner}</svg>`

const f = (n: number) => Number(n.toFixed(2))
const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180
  return [f(cx + r * Math.sin(rad)), f(cy + r * Math.cos(rad))] as const
}

function sector(cx: number, cy: number, r: number, half: number) {
  const [x0, y0] = polar(cx, cy, r, -half)
  const [x1, y1] = polar(cx, cy, r, half)
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 0 0 ${x1} ${y1} Z`
}

function mango() {
  return svg(
    `<defs>${grad("g", ["#FFD84A", "#FFA61F", "#F0532B"])}</defs>` +
      `<path d="M 96 52 C 142 40 182 78 176 126 C 171 166 134 190 94 184 C 66 180 44 172 24 150 C 34 150 42 144 44 132 C 46 92 62 60 96 52 Z" fill="url(#g)"/>` +
      `<path d="M 78 78 C 62 90 56 108 56 126" fill="none" stroke="#FFF3B0" stroke-width="7" stroke-linecap="round" opacity="0.75"/>`,
    "17 33 168 168",
  )
}

function cherry() {
  return svg(
    `<defs>${grad("g", ["#FF6B7F", "#D61F3F", "#8E1030"])}</defs>` +
      stem("M20 32 C 21 20 29 12 41 7", 2.6, "#5E7F2A") +
      stem("M44 34 C 43 24 41 14 41 7", 2.6, "#5E7F2A") +
      leaf(41, 8, -18, 0.85) +
      `<circle cx="20" cy="45" r="14" fill="url(#g)"/><circle cx="44" cy="47" r="14" fill="url(#g)"/>` +
      shine("M13 41 C 13 38 15 35.5 18 34.5", 3.4, "#FFE3E3") +
      shine("M37 43 C 37 40 39 37.5 42 36.5", 3.4, "#FFE3E3"),
  )
}

function lemon() {
  return svg(
    `<defs>${grad("g", ["#FFF58A", "#FFD21F", "#E3A400"])}</defs>` +
      `<g transform="translate(32 34) rotate(-30) scale(0.92) translate(-32 -32)">` +
      `<path d="M 2 32 Q 6 30 9 26 C 15 6 49 6 55 26 Q 58 30 62 32 Q 58 34 55 38 C 49 58 15 58 9 38 Q 6 34 2 32 Z" fill="url(#g)"/>` +
      shine("M 16 22 C 22 14 32 12 40 14", 4.2, "#FFFBD0") +
      `</g>` +
      leaf(36, 14, -62, 0.78),
  )
}

function kiwi() {
  let seeds = ""
  let rays = ""
  for (let i = 0; i < 12; i++) {
    const a = i * 30
    const [sx, sy] = polar(32, 32, 12.5, a)
    seeds += `<ellipse cx="${sx}" cy="${sy}" rx="1.25" ry="2.3" transform="rotate(${-a} ${sx} ${sy})" fill="#2B2A1E"/>`
    const [x0, y0] = polar(32, 32, 8.5, a + 15)
    const [x1, y1] = polar(32, 32, 19, a + 15)
    rays += `<path d="M${x0} ${y0} L${x1} ${y1}" stroke="#E6F5B0" stroke-width="1.1" opacity="0.7" stroke-linecap="round"/>`
  }
  return svg(
    `<defs>${grad("rim", ["#B0824F", "#85572F", "#5C3A1E"])}${radial("fl", ["#C6EC6B", "#7DBE34", "#3F8F2A"])}</defs>` +
      `<circle cx="32" cy="32" r="28" fill="url(#rim)"/>` +
      `<circle cx="32" cy="32" r="24" fill="url(#fl)"/>` +
      rays +
      `<ellipse cx="32" cy="32" rx="8.5" ry="8.5" fill="#F4F9D6"/>` +
      seeds +
      shine("M15 24 C 17 19 21 15.5 26 14", 3, "#F6FFD0", 0.8),
  )
}

function grapes() {
  const rows: Array<[number, number[]]> = [
    [24, [14, 26, 38, 50]],
    [34.5, [20, 32, 44]],
    [45, [26, 38]],
    [55.5, [32]],
  ]
  let balls = ""
  for (const [y, xs] of rows) for (const x of xs) balls += `<circle cx="${x}" cy="${y}" r="7.6" fill="url(#g)"/>`
  let dots = ""
  for (const [y, xs] of rows)
    for (const x of xs) dots += `<circle cx="${x - 2.6}" cy="${y - 2.8}" r="1.5" fill="#F2E4FF" opacity="0.75"/>`
  return svg(
    `<defs>${grad("g", ["#C99BFF", "#8F4FE0", "#5A24A8"])}</defs>` +
      stem("M32 17 C 32 12 34 8 38 5", 2.6) +
      leaf(34, 14, -35, 0.95) +
      balls +
      dots,
  )
}

function pear() {
  return svg(
    `<defs>${grad("g", ["#EAF77A", "#A9D335", "#5F9E22"])}</defs>` +
      stem("M32 14 C 32 9 34 6 37 3.5") +
      leaf(34, 11, -40, 0.85) +
      `<path d="M32 12 C 40 12 42 22 44 29 C 46 35 56 38 56 47 C 56 56 46 61 32 61 C 18 61 8 56 8 47 C 8 38 18 35 20 29 C 22 22 24 12 32 12 Z" fill="url(#g)"/>` +
      shine("M16 44 C 15 49 18 54 23 56", 4, "#F8FFD0"),
  )
}

function strawberry() {
  const seedsAt = [
    [22, 28],
    [32, 26],
    [42, 28],
    [17, 37],
    [27, 36],
    [37, 36],
    [47, 37],
    [23, 46],
    [32, 45],
    [41, 46],
    [32, 54],
  ]
  const seeds = seedsAt
    .map(([x, y]) => `<ellipse cx="${x}" cy="${y}" rx="1.2" ry="1.9" fill="#FFE9A0"/>`)
    .join("")
  return svg(
    `<defs>${grad("g", ["#FF7D8E", "#EA2F50", "#B01230"])}</defs>` +
      `<path d="M32 18 C 44 13 57 18 57 31 C 57 45 42 57 32 61 C 22 57 7 45 7 31 C 7 18 20 13 32 18 Z" fill="url(#g)"/>` +
      seeds +
      shine("M13 28 C 13 24 15 21 19 20", 3.4, "#FFE3E8") +
      `<path d="M32 18 C 26 11 19 11 12 15 C 18 22 27 22 32 18 Z" fill="url(#lf)"/>` +
      `<path d="M32 18 C 38 11 45 11 52 15 C 46 22 37 22 32 18 Z" fill="url(#lf)"/>` +
      `<path d="M32 18 C 28 22 28 28 32 32 C 36 28 36 22 32 18 Z" fill="url(#lf)"/>` +
      stem("M32 18 C 32 13 33 9 35 6", 3),
  )
}

function watermelon() {
  const cx = 32
  const cy = 5
  const seedsAt: Array<[number, number]> = [
    [22, -13],
    [22, 13],
    [32, -24],
    [32, 0],
    [32, 24],
    [41, -12],
    [41, 12],
  ]
  const seeds = seedsAt
    .map(([r, a]) => {
      const [x, y] = polar(cx, cy, r, a)
      return `<ellipse cx="${x}" cy="${y}" rx="1.7" ry="3" transform="rotate(${-a} ${x} ${y})" fill="#2A1B1B"/>`
    })
    .join("")
  const [hx0, hy0] = polar(cx, cy, 36, -22)
  const [hx1, hy1] = polar(cx, cy, 36, -8)
  return svg(
    `<defs>${grad("rind", ["#6FD36A", "#2FA04E", "#1A6B35"])}${grad("fl", ["#FF7E86", "#EE3B52", "#C21E3F"])}</defs>` +
      `<path d="${sector(cx, cy, 55, 39)}" fill="url(#rind)" stroke-linejoin="round"/>` +
      `<path d="${sector(cx, cy, 50, 39)}" fill="#DDF5B0"/>` +
      `<path d="${sector(cx, cy, 46, 39)}" fill="url(#fl)"/>` +
      seeds +
      shine(`M${hx0} ${hy0} A 36 36 0 0 0 ${hx1} ${hy1}`, 3, "#FFE3E3", 0.7),
  )
}

function pineapple() {
  const lines: string[] = []
  for (let i = -4; i <= 4; i++) {
    lines.push(`M${32 + i * 9 - 24} 20 L${32 + i * 9 + 24} 66`, `M${32 + i * 9 + 24} 20 L${32 + i * 9 - 24} 66`)
  }
  const spikes = [-52, 52, -26, 26, 0]
    .map((a) => {
      const L = 24 - Math.abs(a) * 0.12
      return `<path transform="translate(32 25) rotate(${a})" d="M0 0 C -6 ${-L * 0.4} -4 ${-L * 0.8} 0 ${-L} C 4 ${-L * 0.8} 6 ${-L * 0.4} 0 0 Z" fill="url(#lf)"/>`
    })
    .join("")
  return svg(
    `<defs>${grad("g", ["#FFE070", "#F5A623", "#D9730A"])}<clipPath id="c"><ellipse cx="32" cy="43" rx="18" ry="21"/></clipPath></defs>` +
      spikes +
      `<ellipse cx="32" cy="43" rx="18" ry="21" fill="url(#g)"/>` +
      `<g clip-path="url(#c)"><path d="${lines.join(" ")}" stroke="#A8530A" stroke-width="1.6" opacity="0.45" fill="none"/></g>` +
      shine("M19 38 C 18 44 19 50 22 54", 3.4, "#FFF3B0"),
  )
}

function peach() {
  return svg(
    `<defs>${grad("g", ["#FFD7A8", "#FF9A6B", "#EE4F6A"])}</defs>` +
      stem("M32 16 C 32 12 33 9 35 7") +
      leaf(34, 14, -35, 0.9) +
      `<path d="M32 17 C 40 10 56 14 57 32 C 58 48 46 60 32 60 C 18 60 6 48 7 32 C 8 14 24 10 32 17 Z" fill="url(#g)"/>` +
      `<path d="M32 17 C 28 28 28 40 33 50" fill="none" stroke="#C93A5B" stroke-width="2.2" stroke-linecap="round" opacity="0.4"/>` +
      shine("M14 30 C 14 25 17 21 21 19", 3.6, "#FFF3E0"),
  )
}

function coconut() {
  return svg(
    `<defs>${grad("sh", ["#A8744C", "#6E4326", "#3E2414"])}${grad("fl", ["#FFFFFA", "#FBF3DC", "#E8DDBC"])}${grad("cv", ["#E7DDC2", "#CFC3A2", "#B8AB88"])}</defs>` +
      `<circle cx="32" cy="32" r="28" fill="url(#sh)"/>` +
      `<circle cx="32" cy="32" r="22" fill="url(#fl)"/>` +
      `<circle cx="32" cy="32" r="14" fill="url(#cv)"/>` +
      shine("M24 26 C 26 22 29 20.5 33 20.5", 3, "#FFFFFF", 0.85) +
      shine("M11 24 C 12 20 14 17 17 14.5", 3, "#D9A980", 0.7),
  )
}

function fig() {
  const tear = (s: number, id: string) =>
    `<path transform="translate(32 42) scale(${s}) translate(-32 -42)" d="M32 9 C 36 9 38 13 40 19 C 42 25 54 33 54 44 C 54 54 44 60 32 60 C 20 60 10 54 10 44 C 10 33 22 25 24 19 C 26 13 28 9 32 9 Z" fill="${id}"/>`
  const seedsAt = [
    [32, 31],
    [27, 36],
    [37, 36],
    [32, 41],
    [24, 43],
    [40, 43],
    [29, 47],
    [35, 47],
    [32, 52],
  ]
  const seeds = seedsAt.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.1" fill="#FFD9C9"/>`).join("")
  return svg(
    `<defs>${grad("g", ["#C46A92", "#8A3563", "#4F1A3A"])}${grad("pk", ["#FF9DB0", "#E9476E", "#B02256"])}</defs>` +
      `<path d="M29 12 L30.5 4 L34.5 4 L36 12 Z" fill="${BROWN}"/>` +
      tear(1, "url(#g)") +
      tear(0.78, "#FFE6D5") +
      tear(0.66, "url(#pk)") +
      seeds,
  )
}

function plum() {
  return svg(
    `<defs>${grad("g", ["#8F86EE", "#5545C2", "#2D2380"])}</defs>` +
      stem("M32 14 C 32 10 33 7 35 5") +
      leaf(34, 12, -35, 0.85) +
      `<ellipse cx="32" cy="38" rx="25" ry="23" fill="url(#g)"/>` +
      `<path d="M32 16 C 28 26 28 38 34 52" fill="none" stroke="#1E1660" stroke-width="2.2" stroke-linecap="round" opacity="0.4"/>` +
      shine("M13 34 C 13 28 16 23 21 20", 3.8, "#D9D4FF", 0.8),
  )
}

function orange() {
  const pores = [
    [22, 40],
    [34, 31],
    [43, 43],
    [29, 52],
    [46, 31],
    [18, 30],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.9" fill="#B8470C" opacity="0.4"/>`)
    .join("")
  return svg(
    `<defs>${grad("g", ["#FFC668", "#FF8A1F", "#E2570F"])}</defs>` +
      stem("M32 13 C 32 10 33 8 34 6", 2.6) +
      leaf(33, 12, -30, 0.9) +
      `<circle cx="32" cy="37" r="25" fill="url(#g)"/>` +
      pores +
      shine("M14 36 C 14 29 18 23 24 20", 3.8, "#FFF3C0"),
  )
}

function apple() {
  return svg(
    `<defs>${grad("g", ["#FF8A78", "#E5322D", "#A31B22"])}</defs>` +
      stem("M32 20 C 32 14 33 9 36 5", 3) +
      leaf(34, 14, -30, 0.95) +
      `<path d="M32 21 C 38 14 53 16 56 31 C 59 46 49 61 38 61 C 35 61 34 60 32 60 C 30 60 29 61 26 61 C 15 61 5 46 8 31 C 11 16 26 14 32 21 Z" fill="url(#g)"/>` +
      shine("M14 32 C 14 27 17 23 21 21", 3.8, "#FFE3DA"),
  )
}

function banana() {
  return svg(
    `<defs>${grad("g", ["#FFEC8A", "#FFD23F", "#EDA000"])}</defs>` +
      `<path d="M12 9 L22 9 C 22 29 32 43 56 45 C 61 45 61 53 56 53 C 28 59 5 41 8 15 C 8 11 10 9 12 9 Z" fill="url(#g)"/>` +
      `<path d="M12 9 L22 9 L21.4 3.5 Q 17 2.5 12.6 3.5 Z" fill="${BROWN}"/>` +
      `<ellipse cx="58" cy="49" rx="3.4" ry="4.2" fill="${BROWN}"/>` +
      shine("M13 18 C 13 32 21 44 36 50", 3.4, "#FFFBD0", 0.8),
  )
}

const DRAW: Record<ProjectFruit, () => string> = {
  mango,
  cherry,
  lemon,
  kiwi,
  grapes,
  pear,
  strawberry,
  watermelon,
  pineapple,
  peach,
  coconut,
  fig,
  plum,
  orange,
  apple,
  banana,
}

const cache = new Map<ProjectFruit, string>()

/** The fruit as a data URI, ready for `<img src>`. */
export function projectFruitSrc(fruit: ProjectFruit) {
  const cached = cache.get(fruit)
  if (cached) return cached
  const value = `data:image/svg+xml;utf8,${encodeURIComponent(DRAW[fruit]())}`
  cache.set(fruit, value)
  return value
}
