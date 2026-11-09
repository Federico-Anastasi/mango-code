import { describe, expect, test } from "bun:test"
import { mangoDesktopError, mangoPlatform, type MangoDesktop } from "./mango-desktop"

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
    openModels: async () => {},
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
    expect(await files.info("C:\P\a.docx")).toEqual({ size: 11264, isDir: false })
    await files.open("C:\P\a.docx")
    expect(opened).toEqual(["C:\P\a.docx"])
    expect(await files.reveal!("C:\P\a.docx").catch((e) => e)).toEqual({ code: "not_found", message: "x" })
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

describe("mangoDesktopError", () => {
  test("recognizes the command error and wraps the rest", () => {
    expect(mangoDesktopError({ code: "exists", message: "x" })).toEqual({ code: "exists", message: "x" })
    expect(mangoDesktopError(new Error("boom"))).toEqual({ code: "io", message: "boom" })
    expect(mangoDesktopError("text")).toEqual({ code: "io", message: "text" })
  })
})
