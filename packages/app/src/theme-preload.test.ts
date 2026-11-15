import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/oc-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

const system = (dark: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ matches: dark }) as MediaQueryList,
    configurable: true,
  })

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.removeAttribute("data-mango-theme")
  localStorage.clear()
  system(false)
})

describe("theme preload", () => {
  test("without a saved choice the page follows the system, and the suite's stylesheet is told which theme", () => {
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(document.documentElement.dataset.mangoTheme).toBe("light")

    system(true)
    run()
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(document.documentElement.dataset.mangoTheme).toBe("dark")
  })

  test("a saved choice wins over the system", () => {
    localStorage.setItem("opencode-color-scheme", "dark")
    run()
    expect(document.documentElement.dataset.mangoTheme).toBe("dark")

    system(true)
    localStorage.setItem("opencode-color-scheme", "light")
    run()
    expect(document.documentElement.dataset.mangoTheme).toBe("light")
  })

  test("the colours an older version kept for another theme are not put on the page", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.head.children).toHaveLength(0)
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
