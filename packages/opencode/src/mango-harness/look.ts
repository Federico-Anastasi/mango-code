// The sight of the harness: the pictures the model is given and the words around them. Two things give pictures: a web
// page (`page_look`, declared in the `tools.json` of the harnesses that have it and offered when the harness is
// loaded with `vision`) and a file of the project (`read` on an image, or on a PDF page that has no text).
import type { Picture } from "./contracts"

// The longer side of a picture: a vision model typically reads patches of 16 pixels merged two by two, so a side of 768 is 24 tokens
// across and the window of 1280 pixels comes out as 768x490, about 360 tokens, with the text of a page still legible.
export const LOOK_SIDE = 768

/** The line `page_view` and `page_act` end with when the page holds what their text cannot carry. */
export const LOOK_HINT =
  "Parts of this page are not in the text (a canvas, a drawing, a picture with no description, colours that tell buttons apart): `page_look` shows how the page looks."

/** What the call answers in words; the picture itself travels with it. */
export const LOOK_ANSWER = "The picture of the page follows."

/** An image file as the model is given it: a PNG, its longer side at most `LOOK_SIDE`, whatever format the file is in. */
export async function fitted(bytes: Uint8Array): Promise<Picture | Error> {
  try {
    const { width, height } = await new Bun.Image(bytes).metadata()
    const scale = Math.min(1, LOOK_SIDE / Math.max(width, height))
    const image = new Bun.Image(bytes)
    const png = await (
      scale < 1 ? image.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))) : image
    )
      .png()
      .bytes()
    return { mime: "image/png", base64: Buffer.from(png).toString("base64") }
  } catch (e) {
    return new Error(`not a picture that can be read (${(e instanceof Error ? e.message : String(e)).split("\n")[0]})`)
  }
}
