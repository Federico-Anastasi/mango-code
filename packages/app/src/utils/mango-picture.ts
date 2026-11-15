// mango-code: what the box of a conversation asks when it asks for a picture. The words of the user go to the agent as a
// turn of the conversation (`POST /session/<id>/image`); this is the part that needs no page: whether the box opens on
// «Picture», which image model draws, what is sent, and the request that makes a picture again.
import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { PictureFormat, PictureSize } from "@opencode-ai/session-ui/picture-state"
import type { PicturePick } from "@/context/prompt-state"
import type { ImageRewriter } from "@/context/settings"
import { MANGO_PROVIDER } from "@/utils/model-info"
import type { ImageModelEntry, ImageModels } from "@/utils/mango-state"

/** What the agent takes for a picture turn (`session.image`). */
export type PictureRequest = {
  request: string
  format: PictureFormat
  size: PictureSize
  /** Key of the image model. */
  model: string
  /** `false`: the words go to the image model as they are; a model: who rewrites them; absent: the agent's choice. */
  rewrite?: false | ImageRewriter
  /** A description already written: nothing rewrites it. */
  prompt?: string
}

/** The part of a picture turn that the user asked for with words (the agent's own calls have no `request`). */
function askedPicture(part: Part) {
  return part.type === "tool" && part.tool === "image_generate" && typeof part.state.input?.request === "string"
}

/** The last answer of the conversation is a picture that the user asked for. */
export function lastTurnWasPicture(messages: readonly Message[], parts: (messageID: string) => readonly Part[]) {
  const last = messages.findLast((message) => message.role === "assistant")
  return !!last && parts(last.id).some(askedPicture)
}

/** The box opens on what the user chose in it; without a choice, on «Picture» if the last turn was a picture. */
export function pictureMode(pick: PicturePick | undefined, lastWasPicture: boolean): "text" | "picture" {
  return pick?.mode ?? (lastWasPicture ? "picture" : "text")
}

/**
 * The models that write which the agent offers for rewriting a request, as the model menu of the conversation lists
 * them: the visible ones, and of this computer's only those on the disk (`onDisk`).
 */
export function offeredWriters<T extends { id: string; provider: { id: string } }>(
  models: readonly T[],
  keep: { visible: (key: { providerID: string; modelID: string }) => boolean; onDisk: (modelID: string) => boolean },
) {
  return models
    .filter((model) => keep.visible({ providerID: model.provider.id, modelID: model.id }))
    .filter((model) => model.provider.id !== MANGO_PROVIDER || keep.onDisk(model.id))
}

/** The models that draw and are on the computer, in the catalog's order. */
export function pictureModels(images: ImageModels | undefined) {
  return images?.models.filter((model) => model.present) ?? []
}

/**
 * The model that draws: the conversation's choice if it is still on the computer, otherwise the default one, otherwise
 * the first. None when no model that draws is on the computer.
 */
export function pictureModel(
  pick: PicturePick | undefined,
  images: ImageModels | undefined,
): ImageModelEntry | undefined {
  const here = pictureModels(images)
  return (
    here.find((model) => model.key === pick?.model) ?? here.find((model) => model.key === images?.default) ?? here[0]
  )
}

/**
 * The request for the words written in the box. Rewriting is the user's choice in the settings: off, the words go as
 * they are; on, the chosen model writes, if the agent still offers it, otherwise the agent chooses. Nothing without
 * words or without a model that draws.
 */
export function pictureRequest(input: {
  text: string
  pick: PicturePick | undefined
  images: ImageModels | undefined
  rewrite: boolean
  rewriter: ImageRewriter | null
  /** The models that write which the agent offers. */
  offered: readonly ImageRewriter[]
}): PictureRequest | undefined {
  const request = input.text.trim()
  const model = pictureModel(input.pick, input.images)
  if (!request || !model) return
  const saved = input.rewriter
  const writer =
    saved && input.offered.find((item) => item.providerID === saved.providerID && item.modelID === saved.modelID)
  return {
    request,
    format: input.pick?.format ?? "square",
    size: input.pick?.size ?? "small",
    model: model.key,
    ...(!input.rewrite
      ? { rewrite: false as const }
      : writer
        ? { rewrite: { providerID: writer.providerID, modelID: writer.modelID } }
        : {}),
  }
}

/** The sentence of a refusal of the agent, or `undefined` when it has none. */
export function pictureFailure(body: unknown) {
  const error = body as { error?: { message?: unknown }; data?: { message?: unknown }; message?: unknown } | null
  const message = error?.data?.message ?? error?.error?.message ?? error?.message
  return typeof message === "string" && message ? message : undefined
}

/** The request of the picture turn, as the agent takes it; it answers when the turn ends. */
export async function askPicture(
  agent: { url: string; headers: Record<string, string> },
  target: { sessionID: string; directory: string },
  body: PictureRequest,
) {
  const url = new URL(`/session/${encodeURIComponent(target.sessionID)}/image`, agent.url)
  url.searchParams.set("directory", target.directory)
  const response = await fetch(url, {
    method: "POST",
    headers: { ...agent.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (response.ok) return
  const refusal = pictureFailure(await response.json().catch(() => undefined))
  throw new Error(refusal ?? `${response.status}`)
}
