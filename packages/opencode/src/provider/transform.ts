import type { ModelMessage, ToolResultPart } from "ai"
import type * as Provider from "./provider"
import type * as ModelsDev from "@opencode-ai/core/models-dev"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export const OUTPUT_TOKEN_MAX = 32_000

export function sanitizeSurrogates(content: string) {
  return content.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
}

function sanitizeToolResultOutput(content: ToolResultPart) {
  if (content.output.type === "text" || content.output.type === "error-text") {
    content.output.value = sanitizeSurrogates(content.output.value)
  }
  if (content.output.type === "content") {
    content.output.value = content.output.value.map((item) => {
      if (item.type === "text") {
        item.text = sanitizeSurrogates(item.text)
      }
      return item
    })
  }
  return content
}

function sanitizeMessages(msgs: ModelMessage[]): ModelMessage[] {
  return msgs.map((msg) => {
    switch (msg.role) {
      case "tool":
        if (!Array.isArray(msg.content)) return msg
        msg.content = msg.content.map((content) => {
          if (content.type === "tool-result") {
            return sanitizeToolResultOutput(content)
          }
          return content
        })
        return msg

      case "system":
        msg.content = sanitizeSurrogates(msg.content)
        return msg

      case "user":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text") {
              content.text = sanitizeSurrogates(content.text)
            }
            return content
          })
        }
        return msg

      case "assistant":
        if (typeof msg.content === "string") {
          msg.content = sanitizeSurrogates(msg.content)
        } else {
          msg.content = msg.content.map((content) => {
            if (content.type === "text" || content.type === "reasoning") {
              content.text = sanitizeSurrogates(content.text)
            }
            if (content.type === "tool-result") {
              return sanitizeToolResultOutput(content)
            }
            return content
          })
        }
        return msg
    }
  })
}

// A model that reads its reasoning back from a message field gets it there, even when empty: some servers insist on
// the field being present on every assistant turn.
function interleaveReasoning(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  if (typeof model.capabilities.interleaved !== "object" || !model.capabilities.interleaved.field) return msgs
  const field = model.capabilities.interleaved.field
  return msgs.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg
    const reasoningText = msg.content
      .filter((part) => part.type === "reasoning")
      .map((part) => part.text)
      .join("")
    return {
      ...msg,
      content: msg.content.filter((part) => part.type !== "reasoning"),
      providerOptions: {
        ...msg.providerOptions,
        openaiCompatible: {
          ...msg.providerOptions?.openaiCompatible,
          [field]: reasoningText,
        },
      },
    }
  })
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String(part.image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? String(part.image).split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

export function message(msgs: ModelMessage[], model: Provider.Model) {
  return interleaveReasoning(sanitizeMessages(unsupportedParts(msgs, model)), model)
}

export function smallOptions(model: Provider.Model) {
  const small = Object.values(model.variants ?? {})[0] ?? {}
  // mango-code: small jobs on the local engine (today the project-copy suggestion; the session title is made from the
  // first words of the message, without the model) run without thinking: with it a short answer cost ~800 tokens, ~40 s.
  if (model.providerID === "mango" && Object.keys(small).length === 0) {
    return { chat_template_kwargs: { enable_thinking: false } }
  }
  return small
}

export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
  return { [model.providerID.split(".")[0]]: options }
}

export function maxOutputTokens(model: Provider.Model, outputTokenMax = OUTPUT_TOKEN_MAX): number {
  return Math.min(model.limit.output, outputTokenMax) || outputTokenMax
}

export * as ProviderTransform from "./transform"
