import { expect, test } from "bun:test"
import path from "node:path"

const packages = path.join(import.meta.dir, "..", "..", "..")
const roots = ["app/src", "session-ui/src", "ui/src"]

// The app has no shortcuts of its own. A file reads a modifier key (ctrl, meta, alt) only for one of the reasons below:
// a key inside a control, a click or wheel with a modifier, or a key every program has. A new combination has to be
// added here, with its reason, so it cannot slip in unseen.
const modifiers: Record<string, string> = {
  "app/src/components/dialog-select-model.tsx": "arrow keys in the model menu, left alone when a modifier is held",
  "app/src/components/prompt-input.tsx":
    "arrow keys go through the history of the message box, left alone with a modifier",
  "app/src/components/prompt-project-selector.tsx":
    "arrow keys in the project menu, left alone when a modifier is held",
  "app/src/pages/home/home-scroll-controller.ts": "wheel with Ctrl is the page zoom, not scrolled",
  "app/src/pages/home/home-sessions-view.tsx":
    "click with a modifier opens a session in the background; arrows in the search list",
  "app/src/pages/layout/sidebar-project.tsx": "Ctrl+click is the right click on macOS",
  "app/src/pages/session.tsx":
    "typing anywhere goes to the message box, unless a modifier is held; Ctrl+F finds in the conversation",
  "app/src/pages/session/composer/session-question-dock.tsx":
    "arrows move in the question box, left alone with a modifier; Enter with Ctrl or Cmd does not answer",
  "app/src/utils/phone-preview.ts": "a click with a modifier is not taken as a tap",
  "app/src/utils/search-keydown.ts": "select all and text editing keys in a search field",
  "session-ui/src/components/message-part.tsx": "a click with a modifier is left to the browser",
  "session-ui/src/pierre/file-find.ts": "Ctrl+F finds in the file the user is in",
  "session-ui/src/v2/components/prompt-input/interaction.ts":
    "arrows in the lists and the history of the message box, left alone with a modifier",
  "session-ui/src/v2/components/session-review-v2.tsx":
    "arrow keys step through the files of the review, left alone with a modifier",
  "ui/src/components/scroll-view.tsx": "page and arrow keys scroll, left alone with a modifier",
  "ui/src/hooks/use-filtered-list.tsx": "arrows move in a filtered list, left alone with a modifier",
}

async function sources(dirs: string[]) {
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const cwd = path.join(packages, dir)
      const files = await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd }))
      return files.map((file) => `${dir}/${file.replaceAll("\\", "/")}`)
    }),
  )
  return found.flat().filter((file) => !file.includes(".test.") && !file.includes(".stories."))
}

async function matching(files: string[], pattern: RegExp) {
  const hits = await Promise.all(
    files.map(async (file) => (pattern.test(await Bun.file(path.join(packages, file)).text()) ? [file] : [])),
  )
  return hits.flat().sort()
}

test("only the files listed read a modifier key, and each one still does", async () => {
  const files = await sources(roots)
  expect(files.length).toBeGreaterThan(300)

  expect(await matching(files, /ctrlKey|metaKey|altKey/)).toEqual(Object.keys(modifiers).sort())
})

test("no source file registers or shows a key combination", async () => {
  const files = await sources(["app/src", "session-ui/src"])

  expect(await matching(files, /keybind|accelerator/i)).toEqual([])
})
