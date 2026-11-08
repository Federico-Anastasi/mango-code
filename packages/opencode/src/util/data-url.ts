export function decodeDataUrl(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1) return ""

  const head = url.slice(0, idx)
  const body = url.slice(idx + 1)
  if (head.includes(";base64")) return Buffer.from(body, "base64").toString("utf8")
  return decodeURIComponent(body)
}

/** Bytes of a base64 data URL (binary attachments: images, documents). */
export function decodeDataUrlBytes(url: string) {
  const idx = url.indexOf(",")
  if (idx === -1 || !url.slice(0, idx).includes(";base64")) return new Uint8Array()
  return Buffer.from(url.slice(idx + 1), "base64")
}
