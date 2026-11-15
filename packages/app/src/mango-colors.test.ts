import { describe, expect, test } from "bun:test"
import path from "node:path"

// Every colour of the interface is one of the suite's names (`--mango-*`) or a mix of them, so a colour changes in
// one place. A colour written by hand is only right where it is part of the content shown: a drawing, a code theme.
const root = path.resolve(import.meta.dir, "../..")
const folders = ["app/src", "ui/src", "session-ui/src"]

// Files whose colours are content, not interface. Paths are relative to `packages/`.
const content: Record<string, string> = {
  "ui/src/components/logo.tsx": "the gradient of the mango mark",
  "ui/src/v2/components/project-fruits.tsx": "the drawings of the fruits that mark a project",
  "ui/src/context/marked-theme.tsx": "the code-highlighting theme of formatted text",
  "app/src/components/help-button.tsx": "a veil and its text laid over a video frame",
}

// Places where colours are defined once, and from which the rest takes them.
const definitions = [
  "ui/src/theme/",
  "ui/src/styles/colors.css",
  "ui/src/styles/theme.css",
  "ui/src/v2/styles/",
  "app/src/mango-theme.css",
]

// `rgb(from var(--x) r g b / 0.2)` derives a colour from a name: nothing is written by hand.
const hex = /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b(?![\w-])/
const notation = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\((?!from\s)/
const named = /:\s*(?:white|black)\s*[;,}]/

const skipped = (file: string) =>
  /\.(stories|test)\.tsx?$|\.d\.ts$/.test(file) || definitions.some((item) => file.startsWith(item))

const files = folders.flatMap((folder) =>
  [...new Bun.Glob("**/*.{css,ts,tsx}").scanSync({ cwd: path.join(root, folder) })]
    .filter((name) => !name.includes("node_modules"))
    .map((name) => `${folder}/${name.replaceAll("\\", "/")}`)
    .filter((file) => !skipped(file)),
)

/** `file:line` of every line that writes a colour. */
const found = async () =>
  (
    await Promise.all(
      files.map(async (file) =>
        (await Bun.file(path.join(root, file)).text())
          .split(/\r?\n/)
          .flatMap((line, index) =>
            hex.test(line) || notation.test(line) || named.test(line) ? [`${file}:${index + 1}`] : [],
          ),
      ),
    )
  ).flat()

const fileOf = (hit: string) => hit.slice(0, hit.lastIndexOf(":"))

describe("colours", () => {
  test("no colour is written by hand outside the content files", async () => {
    const hits = (await found()).filter((hit) => !(fileOf(hit) in content))
    expect(hits).toEqual([])
  })

  test("every content file still holds a hand-written colour", async () => {
    const holding = new Set((await found()).map(fileOf))
    expect(Object.keys(content).filter((file) => !holding.has(file))).toEqual([])
  })
})
