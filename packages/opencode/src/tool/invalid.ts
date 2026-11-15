import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

// How much of a parser's message is worth reading: it quotes the arguments it was given, a whole file at times.
const SHOWN = 400

const unfinished = (json: string) => {
  try {
    JSON.parse(json)
    return false
  } catch (error) {
    return /unterminated|unexpected end|EOF|end of (?:JSON )?input/i.test(String(error))
  }
}

/**
 * What the model is told about a call whose arguments could not be used. An answer that reaches its token limit stops
 * in the middle of the arguments: the model has to know that, and to send less, not to read its own text again.
 */
export function reason(input: { tool: string; arguments: string; error: string; limit?: number }) {
  if (unfinished(input.arguments)) {
    return [
      `the answer ended before the call to \`${input.tool}\` was complete`,
      input.limit ? ` (an answer holds at most ${input.limit} tokens)` : "",
      ", so nothing was done. ",
      input.tool === "write"
        ? "Write a shorter file: its first part now, then add the rest with `edit`, one part at a time."
        : "Send the call again with less text in it.",
    ].join("")
  }
  if (input.error.length <= SHOWN * 2) return input.error
  return `${input.error.slice(0, SHOWN)} [...] ${input.error.slice(-SHOWN)}`
}

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        output: `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
