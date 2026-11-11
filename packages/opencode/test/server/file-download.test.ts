import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function read(file: string, directory: string, headers: Record<string, string> = {}) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://127.0.0.1:4096/api/fs/read/${file}`, {
      headers: { "x-opencode-directory": directory, host: "127.0.0.1:4096", ...headers },
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("project files read through the server", () => {
  test("pages and scripts of the project come out as inert downloads, never as a page of the server's origin", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "page.html"), "<script>fetch('/session')</script>")
    await Bun.write(path.join(tmp.path, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    await Bun.write(path.join(tmp.path, "app.js"), "export {}")
    await Bun.write(path.join(tmp.path, "photo.png"), "png")

    for (const file of ["page.html", "logo.svg", "app.js"]) {
      const response = await read(file, tmp.path)
      expect({ file, type: response.headers.get("content-type") }).toEqual({
        file,
        type: "text/plain; charset=utf-8",
      })
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${file}"; filename*=UTF-8''${file}`)
      expect(response.headers.get("content-security-policy")).toContain("sandbox")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
    expect(await (await read("page.html", tmp.path)).text()).toBe("<script>fetch('/session')</script>")

    const image = await read("photo.png", tmp.path)
    expect(image.headers.get("content-type")).toBe("image/png")
    expect(image.headers.get("content-security-policy")).toContain("sandbox")
  })

  test("another site cannot open an API address as a page, while the app, clients and media elements still read", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "page.html"), "<p>hi</p>")
    const navigate = (site: string) => ({ "sec-fetch-site": site, "sec-fetch-mode": "navigate" })

    expect((await read("page.html", tmp.path)).status).toBe(200)
    expect((await read("page.html", tmp.path, navigate("same-origin"))).status).toBe(200)
    expect((await read("page.html", tmp.path, navigate("none"))).status).toBe(200)
    expect((await read("page.html", tmp.path, navigate("cross-site"))).status).toBe(403)
    expect((await read("page.html", tmp.path, navigate("same-site"))).status).toBe(403)
    // a media element of the web UI carries no Origin and is not a navigation
    expect(
      (await read("page.html", tmp.path, { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" })).status,
    ).toBe(200)
  })
})
