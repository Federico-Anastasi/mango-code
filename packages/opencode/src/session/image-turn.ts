import { Effect } from "effect"
import path from "path"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { FSUtil } from "@opencode-ai/core/fs-util"
import type { Provider } from "@/provider/provider"
import type { Question } from "@/question"
import type { LLM } from "./llm"
import { draw, fileName, pictureFile, pictureFilePart, pictureOutput, pictureState, requireApp, sides, type Job } from "@/tool/image"
import { rewrite } from "@/server/shared/mango-image-rewrite"
import { tr } from "@/util/mango-language"

// mango-code: a picture that a person asks for in the interface is a turn of the conversation made without the model
// that writes for the answer: the words are rewritten into the description for the image model (asking the person what
// only they know), the app draws, and the result is the one the tool `image_generate` gives, so one renderer shows both.
// This module is the work of the turn; the messages and the run state are the session's (`SessionPrompt.image`).

/** How many questions the person is asked at most; then the model writes the description with what it has. */
const MAX_QUESTIONS = 3

/**
 * What the messages of a picture turn name as their model when the agent has none that writes: a picture needs no
 * model, but every message of a conversation holds one. It is not a model anybody can load, and what looks for the
 * model a conversation was using skips it.
 */
export const NO_MODEL = { providerID: ProviderV2.ID.make("mango-images"), modelID: ModelV2.ID.make("none") }

export type Request = {
  request: string
  format?: "square" | "portrait" | "landscape"
  size?: "small" | "large"
  /** Key of the image model; without it the app's default. */
  model?: string
  /** Who rewrites; absent: Ling if it is on this computer, else the agent's default model; `false`: nobody. */
  rewrite?: false | { providerID: string; modelID: string }
  /** A description already written: nothing rewrites it. */
  prompt?: string
  seed?: number
}

/** What the turn shows in its tool part while it goes on. */
export type Shown = {
  title: string
  input?: Record<string, unknown>
  metadata: Record<string, unknown>
}

/** The finished picture, as the completed tool part holds it. */
export type Done = {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachment: ReturnType<typeof pictureFilePart>
}

export function run(
  turn: {
    provider: Provider.Interface
    llm: LLM.Interface
    question: Question.Interface
    fs: FSUtil.Interface
    /** The assistant message and the call of the tool part: the question is shown at this part. */
    tool: { sessionID: Question.Request["sessionID"]; messageID: Question.Tool["messageID"]; callID: string }
    directory: string
    show: (shown: Shown) => Effect.Effect<void>
  },
  asked: Request,
) {
  return Effect.gen(function* () {
    // Before a model is asked to write: without the app there is nobody to draw what it would write.
    yield* requireApp()
    const format = asked.format ?? "square"
    const size = asked.size ?? "small"
    const [width, height] = sides(size, format)
    const input = {
      request: asked.request,
      format,
      size,
      ...(asked.model ? { model: asked.model } : {}),
      ...(asked.seed === undefined ? {} : { seed: asked.seed }),
    }

    const description =
      asked.prompt ??
      (asked.rewrite === false ? asked.request : yield* describe(turn, asked.request, asked.rewrite, []))
    // The person's own words name the file: the first five after an article, and a cut does not end on a joining word.
    const words = asked.request
      .trim()
      .replace(/^(?:(?:un|uno|una|il|lo|la|i|gli|le|a|an|the)\s+|(?:un|l)['’])/i, "")
      .split(/\s+/)
    const first = words.slice(0, 5)
    const whole = words.length <= 5 ? first.length : first.findLastIndex((word) => word.replace(/[^\p{L}\p{N}]/gu, "").length > 3) + 1
    const name = fileName(first.slice(0, Math.max(1, whole)).join(" "))
    const guess = yield* pictureFile(turn.fs, turn.directory, name)
    const guessed = path.relative(turn.directory, guess)
    const progress = (job: Pick<Job, "status" | "step" | "steps"> & { preview?: string | null }, began?: number) => ({
      title: job.status === "drawing" ? `${guessed} (${job.step}/${job.steps})` : guessed,
      input: { ...input, prompt: description, name },
      metadata: pictureState(job, began, { file: guess, width, height }),
    })
    yield* turn.show(progress({ status: "waiting", step: 0, steps: 0 }))

    const drawn = yield* draw(
      { prompt: description, width, height, file: guess, model: asked.model, seed: asked.seed, stayOn: true },
      { report: (job, began) => turn.show(progress(job, began)) },
    )

    // The name was free when it was chosen; the app says the one the picture really has. The person asked for this
    // picture and judges it, so the result only says what was made: a later message such as "add a hat" must not read
    // as a request to make it again.
    const file = drawn.file
    const shown = path.relative(turn.directory, file)
    return {
      title: shown,
      output: pictureOutput(shown, width, height),
      metadata: {
        file,
        width,
        height,
        began: drawn.began,
        seed: drawn.job.seed,
        model: drawn.job.model,
        request: asked.request,
        prompt: description,
      },
      attachment: pictureFilePart(file, drawn.png),
    } satisfies Done
  })
}

/**
 * The description for the image model: written by the model that rewrites, asking the person what it cannot choose.
 * A question the person dismisses leaves the choice to the model, which is then asked to describe (`settled`).
 */
function describe(
  turn: Parameters<typeof run>[0],
  request: string,
  writer: { providerID: string; modelID: string } | undefined,
  answers: ReadonlyArray<{ question: string; options: ReadonlyArray<string>; answer: string }>,
  settled = false,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    yield* turn.show({
      title: tr("Scrivo la descrizione", "Writing the description"),
      metadata: { stage: "rewriting" },
    })
    const written = yield* rewrite(turn.provider, turn.llm, {
      request,
      answers,
      model: writer,
      // A model the person chose in the settings and removed since is not a reason to lose the picture.
      fallback: true,
      describe: settled || answers.length >= MAX_QUESTIONS,
    }).pipe(Effect.mapError((failure) => new Error(failure.message)))
    if (written.prompt !== undefined) return written.prompt

    const reply = yield* turn.question
      .ask({
        sessionID: turn.tool.sessionID,
        questions: [
          {
            header: tr("Immagine", "Picture"),
            question: written.question,
            options: written.options.map((label) => ({ label, description: "" })),
          },
        ],
        tool: { messageID: turn.tool.messageID, callID: turn.tool.callID },
      })
      .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed(undefined)))
    const answer = reply?.[0]?.join(", ") || tr("nessuna preferenza, scegli tu", "no preference, choose yourself")
    return yield* describe(
      turn,
      request,
      writer,
      [...answers, { question: written.question, options: written.options, answer }],
      reply === undefined,
    )
  })
}

export * as ImageTurn from "./image-turn"
