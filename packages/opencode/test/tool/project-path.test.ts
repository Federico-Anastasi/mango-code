import { describe, expect, test } from "bun:test"
import { ProjectPath } from "../../src/tool/project-path"

const project = "C:\\Users\\name\\Desktop\\bike-shop"
const at = (written: string) => ProjectPath.locate(written, project, "win32")

describe("ProjectPath.locate on Windows", () => {
  test("a relative path and a path with a drive are taken as written", () => {
    expect(at("index.html")).toEqual({ path: `${project}\\index.html` })
    expect(at("css/style.css")).toEqual({ path: `${project}\\css\\style.css` })
    expect(at("D:\\elsewhere\\notes.txt")).toEqual({ path: "D:\\elsewhere\\notes.txt" })
    expect(at("C:/Users/name/Documents/a.txt")).toEqual({ path: "C:\\Users\\name\\Documents\\a.txt" })
  })

  test("a Unix path that names the project folder lands in the project", () => {
    const got = at("/home/user/bike-shop/pages/index.html")
    expect(got.path).toBe(`${project}\\pages\\index.html`)
    expect(got.note).toContain("`/home/user/bike-shop/pages/index.html` is not a path of this computer")
    expect(got.note).toContain("`pages\\index.html` in the project folder")
    expect(at("/home/user/bike-shop").path).toBe(project)
    expect(at("/home/user/Bike-Shop/").path).toBe(project)
  })

  test("a Unix path that does not name it lands in the project too, without the Unix root", () => {
    expect(at("/tmp/server.log").path).toBe(`${project}\\server.log`)
    expect(at("/home/user/site/index.html").path).toBe(`${project}\\site\\index.html`)
    expect(at("/workspace/page.html").path).toBe(`${project}\\page.html`)
    expect(at("/src/app.js").path).toBe(`${project}\\src\\app.js`)
    expect(at("/index.html").path).toBe(`${project}\\index.html`)
    expect(at("/tmp/server.log").note).toBeDefined()
  })

  test("a path without a drive that is real on Windows is left alone", () => {
    expect(at("/Users/name/Desktop/bike-shop/index.html")).toEqual({ path: `${project}\\index.html` })
    expect(at("/Users/name/Documents/a.txt")).toEqual({ path: "C:\\Users\\name\\Documents\\a.txt" })
    expect(at("/c/Users/name/Documents/a.txt")).toEqual({ path: "C:\\Users\\name\\Documents\\a.txt" })
    expect(at("\\\\server\\share\\a.txt")).toEqual({ path: "\\\\server\\share\\a.txt" })
  })
})

test("elsewhere a path is resolved from the project folder and nothing more", () => {
  expect(ProjectPath.locate("/tmp/x", "/home/name/site", "linux").note).toBeUndefined()
})
