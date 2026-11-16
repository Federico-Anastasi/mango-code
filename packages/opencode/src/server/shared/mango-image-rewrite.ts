import { Effect, Option, Schema, Stream } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { existsSync, statSync } from "node:fs"
import { LLMEvent } from "@opencode-ai/llm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Agent } from "@/agent/agent"
import type { InstanceStore } from "@/project/instance-store"
import type { Provider } from "@/provider/provider"
import type { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { tr } from "@/util/mango-language"
import RULES from "./mango-image-rewrite.txt"

// mango-code: what a person asks for a picture, in their own words and language, is handed to a model that writes,
// which turns it into the description the image model draws best, or asks the one thing it cannot choose by itself.
// How to do it is in the rules next to this file; the conversation it sees is the request, then its own questions
// with the person's answers.
//   POST /mango/image/rewrite?directory=<work>
//     { "request", "answers"?: [{ "question", "options", "answer" }], "model"?: { "providerID", "modelID" } }
//     -> { "prompt", "model" }              the description, in English, for the image model
//      | { "question", "options", "model" } to ask the person: then the same request again, with the answer added
//   `model` in the answer is the one that wrote. The request names it; without a name it is Ling, the model the rules
//   were tuned on, if it is on this computer, otherwise the agent's default model: any model that writes can do it,
//   also one that is not on this computer.
//   Errors are `{ "error": { "message", "type": "mango_image" } }`: 400 a request that cannot be read, 404 no model,
//   502 the model did not answer, or not in the form the rules ask for.
// Whoever asks for the picture decides whether to pass through here at all: the request can go to the image model
// as it is. The picture turn of a session (`POST /session/:sessionID/image`) rewrites with the same function.
export const REWRITE_PATH = "/mango/image/rewrite"

const Asked = Schema.Struct({
  request: Schema.String,
  answers: Schema.optional(
    Schema.Array(
      Schema.Struct({ question: Schema.String, options: Schema.Array(Schema.String), answer: Schema.String }),
    ),
  ),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
})

// A request for a picture is a few lines: a longer body is not one.
export const MAX_BODY = 32 * 1024
const LING = { providerID: ProviderV2.ID.make("mango"), modelID: ModelV2.ID.make("ling") }

// The engine of this computer runs one model at a time. This header tells its manager that the request is not a
// conversation's, so that the model it loads does not become the one the conversations follow (docs/INTEGRATION.md).
const SIDE_REQUEST = "X-Mango-Side-Request"

// The rules are the whole system prompt: as the agent's own prompt they take the place of Mango Code's, which would
// make the model answer as an assistant. Temperature and top-p are the values the rules were tried with, and the
// model answers without reasoning, as for every small job.
const WRITER: Agent.Info = {
  name: "image-request",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  prompt: RULES,
  temperature: 0.7,
  topP: 0.8,
}

// Added to the rules for the last round of a conversation that has asked as much as it may.
const NO_MORE_QUESTIONS =
  "The person cannot be asked anything more. Reply in the first way, with PROMPT, using the answers you have and choosing the rest yourself."

const failure = (message: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error: { message, type: "mango_image" } }, { status })

export function rewriteEffect(
  request: HttpServerRequest.HttpServerRequest,
  store: InstanceStore.Interface,
  provider: Provider.Interface,
  llm: LLM.Interface,
) {
  return Effect.gen(function* () {
    const directory = new URL(request.url, "http://localhost").searchParams.get("directory")
    if (!directory) return failure(tr("manca directory", "directory is missing"), 400)
    if (!existsSync(directory) || !statSync(directory).isDirectory())
      return failure(tr(`non è una cartella: ${directory}`, `not a folder: ${directory}`), 404)
    const body = yield* request.text.pipe(Effect.option)
    if (Option.isNone(body) || body.value.length > MAX_BODY)
      return failure(tr("richiesta illeggibile o troppo grande", "the request cannot be read, or is too large"), 400)
    const asked = Schema.decodeUnknownOption(Schema.fromJsonString(Asked))(body.value)
    if (Option.isNone(asked) || !asked.value.request.trim())
      return failure(tr("manca la richiesta («request»)", "the request («request») is missing"), 400)

    return yield* store.provide(
      { directory },
      rewrite(provider, llm, asked.value).pipe(
        Effect.map((answer) => HttpServerResponse.jsonUnsafe(answer)),
        Effect.catchTag("MangoImageRewriteFailure", (error) => Effect.succeed(failure(error.message, error.status))),
      ),
    )
  })
}

export class RewriteFailure extends Schema.TaggedErrorClass<RewriteFailure>()("MangoImageRewriteFailure", {
  message: Schema.String,
  status: Schema.Number,
}) {}

export type Rewritten = (
  | { prompt: string; question?: undefined; options?: undefined }
  | { question: string; options: string[]; prompt?: undefined }
) & { model: { providerID: string; modelID: string } }

/**
 * One round with the model that writes: the request and the answers given so far in, the description or the next
 * question out, with the model that wrote. `describe` closes the round to questions: the model is told that nothing
 * more can be asked and must give the description. Runs in the folder's instance, which the caller provides.
 */
export function rewrite(
  provider: Provider.Interface,
  llm: LLM.Interface,
  asked: {
    request: string
    answers?: ReadonlyArray<{ question: string; options: ReadonlyArray<string>; answer: string }>
    model?: { providerID: string; modelID: string }
    /** A model that is named but not offered any more is replaced by the automatic choice instead of failing. */
    fallback?: boolean
    describe?: boolean
  },
) {
  return Effect.gen(function* () {
    const named = asked.model
    const automatic = provider.getModel(LING.providerID, LING.modelID).pipe(
      Effect.catch(() =>
        provider
          .defaultModel()
          .pipe(Effect.flatMap((chosen) => provider.getModel(chosen.providerID, chosen.modelID))),
      ),
      Effect.option,
    )
    const chosen = named
      ? yield* provider.getModel(ProviderV2.ID.make(named.providerID), ModelV2.ID.make(named.modelID)).pipe(Effect.option)
      : Option.none()
    const model = Option.isSome(chosen) || (named && !asked.fallback) ? chosen : yield* automatic
    if (Option.isNone(model))
      return yield* new RewriteFailure({
        message: named && !asked.fallback
          ? tr(`il modello «${named.modelID}» non c'è`, `there is no model «${named.modelID}»`)
          : tr("non c'è un modello che scrive", "there is no model that writes"),
        status: 404,
      })

    const sessionID = SessionID.descending()
    const written = yield* llm
      .stream({
        agent: asked.describe ? { ...WRITER, prompt: `${RULES.trimEnd()}\n\n${NO_MORE_QUESTIONS}` } : WRITER,
        user: {
          id: MessageID.ascending(),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: WRITER.name,
          model: { providerID: model.value.providerID, modelID: model.value.id },
        },
        system: [],
        small: true,
        tools: {},
        model:
          model.value.providerID === LING.providerID
            ? { ...model.value, headers: { ...model.value.headers, [SIDE_REQUEST]: "1" } }
            : model.value,
        sessionID,
        retries: 1,
        messages: [
          { role: "user", content: asked.request },
          ...(asked.answers ?? []).flatMap((turn) => [
            { role: "assistant" as const, content: `QUESTION: ${turn.question}\nOPTIONS: ${turn.options.join(" | ")}` },
            { role: "user" as const, content: turn.answer },
          ]),
        ],
      })
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
        Effect.option,
      )
    const wrote = { providerID: model.value.providerID, modelID: model.value.id }
    if (Option.isNone(written))
      return yield* new RewriteFailure({
        message: tr(`il modello «${wrote.modelID}» non ha risposto`, `the model «${wrote.modelID}» did not answer`),
        status: 502,
      })
    const answer = read(written.value)
    // A model told to describe that asks anyway has not answered in the form the rules ask for.
    if (!answer || (asked.describe && "question" in answer))
      return yield* new RewriteFailure({
        message: tr(
          `il modello «${wrote.modelID}» non ha risposto nella forma chiesta`,
          `the model «${wrote.modelID}» did not answer in the form asked`,
        ),
        status: 502,
      })
    return "question" in answer
      ? ({ question: answer.question, options: answer.options, model: wrote } satisfies Rewritten)
      : ({ prompt: answer.prompt, model: wrote } satisfies Rewritten)
  })
}

/** What the model wrote: a description, a question with the answers to offer, or neither. */
export function read(text: string): { prompt: string } | { question: string; options: string[] } | undefined {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  const prompt = clean.indexOf("PROMPT:")
  const question = clean.indexOf("QUESTION:")
  if (question !== -1 && (prompt === -1 || question < prompt)) {
    const parts = clean.slice(question + "QUESTION:".length).split("OPTIONS:")
    const asked = parts[0].trim()
    if (!asked) return undefined
    return {
      question: asked,
      options: (parts[1] ?? "")
        .split("|")
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 4),
    }
  }
  if (prompt === -1) return undefined
  const described = clean
    .slice(prompt + "PROMPT:".length)
    .split(/\s+/)
    .join(" ")
    .trim()
  return described ? { prompt: described } : undefined
}
