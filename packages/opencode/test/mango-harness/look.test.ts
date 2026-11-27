// The picture of an image file as the model is given it, tried without a browser: always a PNG, never larger than the
// pictures of a page, whatever format the file is in.
import { expect, test } from "bun:test"
import { fitted, LOOK_SIDE } from "@/mango-harness/look"

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const GIF = Buffer.from("R0lGODlhAQABAIAAAP8AAAAAACwAAAAAAQABAAACAkQBADs=", "base64")
const PNG_MARK = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const sized = async (bytes: Uint8Array) => (await new Bun.Image(bytes).metadata()) as { width: number; height: number }
const decoded = (base64: string) => Buffer.from(base64, "base64")

test("a picture as large as the pictures of a page, or smaller, is kept at its size", async () => {
  const picture = await fitted(await new Bun.Image(PIXEL).resize(LOOK_SIDE, 300).png().bytes())
  expect(picture instanceof Error).toBe(false)
  if (picture instanceof Error) return
  expect(picture.mime).toBe("image/png")
  expect(await sized(decoded(picture.base64))).toMatchObject({ width: LOOK_SIDE, height: 300, format: "png" })
})

test("a larger picture is brought to the longer side of the pictures of a page, with its proportions", async () => {
  const wide = await fitted(await new Bun.Image(PIXEL).resize(3000, 1500).png().bytes())
  const tall = await fitted(await new Bun.Image(PIXEL).resize(500, 2000).png().bytes())
  if (wide instanceof Error || tall instanceof Error) throw new Error("not fitted")
  expect(await sized(decoded(wide.base64))).toMatchObject({ width: LOOK_SIDE, height: LOOK_SIDE / 2 })
  expect(await sized(decoded(tall.base64))).toMatchObject({ width: LOOK_SIDE / 4, height: LOOK_SIDE })
})

test("JPEG, GIF and WebP files come out as PNG", async () => {
  const jpeg = await new Bun.Image(PIXEL).resize(40, 30).jpeg().bytes()
  const webp = await new Bun.Image(PIXEL).resize(40, 30).webp().bytes()
  for (const bytes of [jpeg, GIF, webp]) {
    const picture = await fitted(bytes)
    if (picture instanceof Error) throw picture
    expect([...decoded(picture.base64).subarray(0, 8)]).toEqual(PNG_MARK)
  }
})

test("bytes that are not a picture are an Error that says so", async () => {
  const picture = await fitted(Buffer.from("this is not a picture"))
  expect(picture instanceof Error).toBe(true)
  expect(picture instanceof Error && picture.message).toStartWith("not a picture")
})
