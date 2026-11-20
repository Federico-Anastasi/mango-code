import { describe, expect, test } from "bun:test"
import { pathKey, folderKey } from "./path-key"

describe("folderKey", () => {
  test("is the same for every spelling of a Windows folder", () => {
    const key = folderKey("C:\\Users\\Me\\Repo")
    expect(folderKey("c:/users/me/repo/")).toBe(key)
    expect(folderKey("C:/Users/Me/Repo")).toBe(key)
    expect(folderKey("c:\\USERS\\me\\repo\\\\")).toBe(key)
    expect(folderKey("C:\\")).toBe(folderKey("c:"))
    expect(folderKey("c:/")).toBe(folderKey("C:\\"))
  })

  test("tells different Windows folders apart", () => {
    expect(folderKey("C:\\x")).not.toBe(folderKey("D:\\x"))
    expect(folderKey("C:\\x")).not.toBe(folderKey("C:\\x\\y"))
  })

  test("a network path keeps its case, which can matter (WSL), but not its slashes", () => {
    const key = folderKey("\\\\wsl$\\Ubuntu\\home\\Me\\Repo")
    expect(String(key)).toBe("//wsl$/Ubuntu/home/Me/Repo")
    expect(folderKey("\\\\wsl$\\Ubuntu\\home\\Me\\Repo\\")).toBe(key)
    expect(folderKey("\\\\wsl$\\Ubuntu\\home\\me\\repo")).not.toBe(key)
    expect(folderKey("\\\\Server\\Share\\Dir\\\\")).toBe(folderKey("\\\\Server\\Share\\Dir"))
    expect(folderKey("\\\\Server\\Share\\Dir")).not.toBe(folderKey("\\\\server\\share\\dir"))
  })

  test("the long form of a path is the path", () => {
    expect(folderKey("\\\\?\\C:\\Users\\Me")).toBe(folderKey("c:/users/me"))
    expect(folderKey("\\\\?\\UNC\\Server\\Share\\Dir")).toBe(folderKey("\\\\Server\\Share\\Dir"))
    expect(folderKey("//?/C:/Users/Me")).toBe(folderKey("C:\\Users\\Me"))
  })

  test("only a drive letter, a colon and a slash (or the end) make a Windows path", () => {
    expect(String(folderKey("a:b\\C"))).toBe("a:b\\C")
    expect(String(folderKey("A:b/"))).toBe("A:b")
    expect(String(pathKey("x:y\\z"))).toBe("x:y\\z")
    expect(String(pathKey("1:\\x"))).toBe("1:\\x")
    expect(String(pathKey("ab:\\x"))).toBe("ab:\\x")
    expect(String(folderKey("c:"))).toBe("c:/")
    expect(String(folderKey("C:\\Users"))).toBe("c:/users")
  })

  test("leaves the case of other paths alone", () => {
    expect(folderKey("/Repo")).not.toBe(folderKey("/repo"))
    expect(folderKey("/repo/")).toBe(pathKey("/repo"))
    expect(String(folderKey("/Home/Me"))).toBe("/Home/Me")
    expect(String(folderKey("/"))).toBe("/")
  })

  test("pathKey, which also gives the keys of the per-folder stores that are used as paths, keeps the case", () => {
    expect(String(pathKey("C:\\Users\\Me\\Repo"))).toBe("C:/Users/Me/Repo")
  })
})
