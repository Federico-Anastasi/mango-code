import { describe, expect, test } from "bun:test"
import { mangoDesktopError, mangoPlatform, nextZoom, type MangoDesktop } from "./mango-desktop"

function bridge(overrides: Partial<MangoDesktop> = {}) {
  const opened: string[] = []
  const value: MangoDesktop = {
    pickDirectories: async () => ["C:\\Users\\a\\one", "C:\\Users\\a\\two"],
    projectsFolder: async () => "C:\\Users\\a\\Documents\\Mango Code",
    createProject: async (name, parent = "C:\\Users\\a\\Documents\\Mango Code") => `${parent}\\${name}`,
    readClipboardImage: async () => null,
    openExternal: async (url) => {
      opened.push(url)
    },
    fileInfo: async () => ({ size: 11264, isDir: false }),
    openPath: async (path) => {
      opened.push(path)
    },
    revealPath: async () => {},
    pendingSettings: async () => null,
    reportProblem: async () => ({ sent: true }),
    reportInfo: async () => ({ maxBytes: 30 * 1024 * 1024, attachments: true, screenshot: true }),
    openLogs: async () => {},
    ...overrides,
  }
  return { value, opened }
}

describe("mangoPlatform", () => {
  test("picker: a single folder if not multiple, the array if multiple, null if cancelled", async () => {
    const platform = mangoPlatform(bridge().value)
    expect(await platform.pickNativeDirectories!({ multiple: true })).toEqual(["C:\\Users\\a\\one", "C:\\Users\\a\\two"])
    expect(await platform.pickNativeDirectories!({})).toBe("C:\\Users\\a\\one")
    const cancelled = mangoPlatform(bridge({ pickDirectories: async () => null }).value)
    expect(await cancelled.pickNativeDirectories!({ multiple: true })).toBeNull()
  })

  test("new project: in the default folder or in the chosen one", async () => {
    const platform = mangoPlatform(bridge().value)
    expect(await platform.projectsFolder!()).toBe("C:\\Users\\a\\Documents\\Mango Code")
    expect(await platform.createProjectFolder!("site")).toBe("C:\\Users\\a\\Documents\\Mango Code\\site")
    expect(await platform.createProjectFolder!("site", "D:\\work")).toBe("D:\\work\\site")
  })

  test("clipboard image: PNG File, or null without an image", async () => {
    expect(await mangoPlatform(bridge().value).readClipboardImage!()).toBeNull()
    const png = new Uint8Array([137, 80, 78, 71]).buffer
    const file = await mangoPlatform(bridge({ readClipboardImage: async () => png }).value).readClipboardImage!()
    expect(file?.type).toBe("image/png")
    expect(file?.size).toBe(4)
  })

  test("project files: the three bridge commands, with the bridge error arriving intact", async () => {
    const { value, opened } = bridge({
      revealPath: async () => {
        throw { code: "not_found", message: "x" }
      },
    })
    const files = mangoPlatform(value).projectFiles!
    expect(await files.info("C:\\P\\a.docx")).toEqual({ size: 11264, isDir: false })
    await files.open("C:\\P\\a.docx")
    expect(opened).toEqual(["C:\\P\\a.docx"])
    expect(await files.reveal!("C:\\P\\a.docx").catch((e) => e)).toEqual({ code: "not_found", message: "x" })
  })

  test("a PDF, a picture or a web page opens in the preview panel, the other documents in their Windows program", async () => {
    const shown: string[] = []
    const preview = { openFile: async (path: string) => void shown.push(path) } as unknown as MangoDesktop["preview"]
    const { value, opened } = bridge({ preview })
    const files = mangoPlatform(value).projectFiles!
    for (const name of ["a.pdf", "b.PNG", "c.svg", "index.html", "old.HTM"]) await files.open(`C:\\P\\${name}`)
    await files.open("C:\\P\\d.docx")
    expect(shown).toEqual(["C:\\P\\a.pdf", "C:\\P\\b.PNG", "C:\\P\\c.svg", "C:\\P\\index.html", "C:\\P\\old.HTM"])
    expect(opened).toEqual(["C:\\P\\d.docx"])
    // a panel that refuses says why: the card shows it
    const refusing = bridge({ preview: { openFile: async () => Promise.reject({ code: "too_large", message: "x" }) } as unknown as MangoDesktop["preview"] })
    expect(await mangoPlatform(refusing.value).projectFiles!.open("C:\\P\\big.pdf").catch((e) => e)).toEqual({ code: "too_large", message: "x" })
  })

  test("external links: only http, https and mailto go through the bridge", () => {
    const { value, opened } = bridge()
    const platform = mangoPlatform(value)
    platform.openExternal("https://example.com/a")
    platform.openExternal("mailto:a@b.it")
    platform.openExternal("file:///C:/Windows/notepad.exe")
    platform.openExternal("javascript:alert(1)")
    platform.openExternal("not a url")
    expect(opened).toEqual(["https://example.com/a", "mailto:a@b.it"])
  })
})

describe("the size of the window", () => {
  test("− and + go by the browser's own steps, stop at 25% and 500%, and a zoom between two steps goes to the next", () => {
    expect(nextZoom(1, 1)).toBe(1.1)
    expect(nextZoom(1, -1)).toBe(0.9)
    expect(nextZoom(1.25, 1)).toBe(1.5)
    expect(nextZoom(1.2, 1)).toBe(1.25)
    expect(nextZoom(1.2, -1)).toBe(1.1)
    // WebView2 may tell a step with a little error: it is still that step
    expect(nextZoom(1.0999, 1)).toBe(1.25)
    expect(nextZoom(5, 1)).toBe(5)
    expect(nextZoom(0.25, -1)).toBe(0.25)
  })
})

describe("the updater of the app", () => {
  /**
   * An app that keeps the choice of the check at each start as `updater.rs` does: the answer is the state of now with the
   * choice saved; it refuses only while it is still starting (`unavailable`) or when the file cannot be written.
   */
  function app(automatic: boolean, starting = false) {
    const calls: boolean[] = []
    let current = automatic
    const updates: NonNullable<MangoDesktop["updates"]> = {
      state: async () => ({ status: "up-to-date", automatic: current }),
      check: async () => ({ status: "up-to-date", automatic: current }),
      setAutomatic: async (next) => {
        calls.push(next)
        if (starting) throw { code: "unavailable", message: "Mango Code is still starting." }
        current = next
        return { status: "up-to-date", automatic: next }
      },
      install: async () => {},
    }
    return { calls, updater: mangoPlatform(bridge({ updates }).value).updater! }
  }

  test("an app without the choice (before 0.1.4) gives an updater without it, and its report reads", async () => {
    const updates: NonNullable<MangoDesktop["updates"]> = {
      state: async () => ({ status: "up-to-date" }),
      check: async () => ({ status: "up-to-date" }),
      install: async () => {},
    }
    const updater = mangoPlatform(bridge({ updates }).value).updater!
    await Promise.resolve()
    expect(updater.setAutomatic).toBeUndefined()
    expect(updater.automatic).toBeUndefined()
    expect(updater.state()).toMatchObject({ status: "up-to-date" })
  })

  test("there is no updater where the app has none", () => {
    expect(mangoPlatform(bridge().value).updater).toBeUndefined()
  })

  test("it starts from what the app says: the state and whether the check at each start is on", async () => {
    const { updater } = app(false)
    await Promise.resolve()
    expect(updater.state()).toMatchObject({ status: "up-to-date" })
    expect(updater.automatic!()).toBe(false)
  })

  test("the choice goes to the app and the page follows its answer", async () => {
    const { calls, updater } = app(true)
    await updater.setAutomatic!(false)
    expect(calls).toEqual([false])
    expect(updater.automatic!()).toBe(false)
    expect(updater.state().status).toBe("up-to-date")
  })

  test("a choice the app refuses reaches the caller and leaves the page as it was", async () => {
    const { updater } = app(true, true)
    await Promise.resolve()
    expect(await updater.setAutomatic!(false).catch((cause) => cause)).toEqual({
      code: "unavailable",
      message: "Mango Code is still starting.",
    })
    expect(updater.automatic!()).toBe(true)
  })

  test("the app's own events change both", async () => {
    const { updater } = app(true)
    window.dispatchEvent(new CustomEvent("mango-update", { detail: { status: "ready", version: "0.2.0", automatic: false } }))
    expect(updater.state()).toMatchObject({ status: "ready", version: "0.2.0" })
    expect(updater.automatic!()).toBe(false)
  })

  test("a check gives the report and updates the page", async () => {
    const { updater } = app(false)
    expect(await updater.check()).toMatchObject({ status: "up-to-date", automatic: false })
    expect(updater.automatic!()).toBe(false)
  })

  test("the time of the last check is the app's, and a report without it keeps the one there was", async () => {
    const { updater } = app(true)
    await Promise.resolve()
    expect(updater.checkedAt!()).toBeUndefined()
    window.dispatchEvent(new CustomEvent("mango-update", { detail: { status: "up-to-date", checked_at: 1_700_000_000_000 } }))
    expect(updater.checkedAt!()).toBe(1_700_000_000_000)
    window.dispatchEvent(new CustomEvent("mango-update", { detail: { status: "checking", checked_at: null } }))
    expect(updater.checkedAt!()).toBe(1_700_000_000_000)
  })
})

describe("mangoDesktopError", () => {
  test("recognizes the command error and wraps the rest", () => {
    expect(mangoDesktopError({ code: "exists", message: "x" })).toEqual({ code: "exists", message: "x" })
    expect(mangoDesktopError(new Error("boom"))).toEqual({ code: "io", message: "boom" })
    expect(mangoDesktopError("text")).toEqual({ code: "io", message: "text" })
  })
})
