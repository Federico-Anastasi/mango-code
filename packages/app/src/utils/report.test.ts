import { describe, expect, test } from "bun:test"
import { addAttachments, formatSize, reportBody } from "./report"

const file = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: "application/octet-stream" })

describe("addAttachments", () => {
  test("files are added in order and the same file twice counts once", () => {
    const a = file("a.png", 10)
    const first = addAttachments([], [a, file("b.pdf", 20)], 100)
    expect(first.files.map((f) => f.name)).toEqual(["a.png", "b.pdf"])
    expect(first.refused).toBeUndefined()
    const again = addAttachments(first.files, [a], 100)
    expect(again.files).toHaveLength(2)
  })

  test("a file that is too large is refused and the others stay", () => {
    const result = addAttachments([file("a", 10)], [file("movie.mp4", 101), file("b", 5)], 100)
    expect(result.files.map((f) => f.name)).toEqual(["a", "b"])
    expect(result.refused).toEqual({ kind: "file", name: "movie.mp4", size: 101 })
  })

  test("together they stay within the limit: the file that would go over is refused", () => {
    const result = addAttachments([file("a", 60)], [file("b", 50)], 100)
    expect(result.files.map((f) => f.name)).toEqual(["a"])
    expect(result.refused).toEqual({ kind: "total", name: "b", size: 110 })
    // exactly the limit is allowed
    expect(addAttachments([file("a", 60)], [file("b", 40)], 100).refused).toBeUndefined()
  })
})

describe("formatSize", () => {
  test("like the app's messages: KB under a megabyte, MB with one decimal", () => {
    expect(formatSize(0)).toBe("0 KB")
    expect(formatSize(1_500)).toBe("2 KB")
    expect(formatSize(30_000_000)).toBe("30.0 MB")
    expect(formatSize(12_340_000)).toBe("12.3 MB")
  })
})

describe("reportBody", () => {
  test("the length of the header, the header, then the files as they are", async () => {
    const png = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" })
    const bytes = new Uint8Array(await (await reportBody({ note: "it hangs", files: [png] })).arrayBuffer())
    const length = new DataView(bytes.buffer).getUint32(0)
    const header = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length)))
    expect(header).toEqual({
      error: null,
      note: "it hangs",
      page: null,
      screenshot: false,
      files: [{ name: "screen.png", type: "image/png", size: 3 }],
    })
    expect([...bytes.slice(4 + length)]).toEqual([1, 2, 3])
  })
})
