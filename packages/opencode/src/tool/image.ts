import { Effect, Exit, Option, Schema } from "effect"
import path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./image.txt"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { tr } from "@/util/mango-language"
import type { Provider } from "@/provider/provider"

// mango-code: the model that writes asks the app for a picture. The app's control server makes it (the image engine
// takes a card, the model that writes there is put aside and comes back), writes the file and tells the steps; the
// tool waits for the job and gives the picture back with its result. The drawing itself (`draw`) is shared with the
// turn of a session that a person starts from the interface (`session/image-turn.ts`): both ask the same server in the
// same way and both end with the same result.

export const PictureFormat = Schema.Literals(["square", "portrait", "landscape"])
export const PictureSize = Schema.Literals(["small", "large"])

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "What the picture shows, in English: subject, setting, style, light, framing",
  }),
  name: Schema.String.annotate({
    description: "File name of the picture, without extension: a few lowercase words joined by dashes (cat-on-sofa)",
  }),
  format: Schema.optional(PictureFormat).annotate({
    description: "The shape of the picture: square (default), portrait (9:16) or landscape (16:9)",
  }),
  size: Schema.optional(PictureSize).annotate({
    description: "small (default) is quicker; large for the final picture",
  }),
})

// Width and height in pixels: multiples of 16, as the image models want them.
const SIDES = {
  small: { square: [768, 768], portrait: [576, 1024], landscape: [1024, 576] },
  large: { square: [1024, 1024], portrait: [720, 1280], landscape: [1280, 720] },
} as const

/** Width and height of a picture of this size and format. */
export function sides(
  size: Schema.Schema.Type<typeof PictureSize> = "small",
  format: Schema.Schema.Type<typeof PictureFormat> = "square",
) {
  return SIDES[size][format]
}

const Job = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["waiting", "preparing", "drawing", "finishing", "done", "failed", "cancelled"]),
  model: Schema.String,
  seed: Schema.NullOr(Schema.Number),
  step: Schema.Number,
  steps: Schema.Number,
  error: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  // Where the app wrote the picture once the job is done: the name asked for, or the next free one if that was taken.
  file: Schema.NullOr(Schema.String),
  // The picture as it is at this step, small, a PNG in base64; only while it is drawn.
  preview: Schema.optional(Schema.NullOr(Schema.String)),
})
export type Job = Schema.Schema.Type<typeof Job>
const Picture = Schema.Struct({ png: Schema.String })
const Models = Schema.Struct({ models: Schema.Array(Schema.Struct({ ready: Schema.Boolean })) })
const Failure = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })

// What the model is told when no model that draws is on the computer. The row of the call in the conversation shows
// the user the same thing with the button that opens the settings on those models (`missing` in its metadata).
const NO_MODEL =
  "No picture was made: no model that draws is on this computer yet. Tell the user so, in their language: the «Download a model» button under this message opens the settings where they get one, and then they can ask for the picture again."

// A job is asked every this often: a step of the fastest card takes longer.
const EVERY = "700 millis"

// The app is on this computer and its calls are quick: one that does not answer in this time is not going to. The
// picture is a PNG of some megabytes in base64, and the cancel is the one call that must not hold a stopped turn.
const LIMIT = { call: 5_000, picture: 30_000, cancel: 3_000 }

export const ImageTool = Tool.define(
  "image_generate",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const [width, height] = sides(params.size, params.format)

          yield* requireApp()
          const here = yield* control("GET", "/control/image", Models)
          if (!here.models.some((model) => model.ready)) {
            yield* ctx.metadata({ title: params.name, metadata: { missing: true } })
            return yield* Effect.fail(new Error(NO_MODEL))
          }

          // The user is asked at the first picture of a conversation; after that the agent goes on by itself.
          const already = ctx.messages.some((message) =>
            message.parts.some(
              (part) => part.type === "tool" && part.tool === ImageTool.id && part.state.status === "completed",
            ),
          )
          if (!already) {
            yield* ctx.metadata({ title: params.name, metadata: { stage: "asking" } })
            yield* ctx.ask({
              permission: "image",
              patterns: [params.name],
              always: ["*"],
              metadata: { prompt: params.prompt, width, height },
            })
          }

          const guess = yield* pictureFile(fs, instance.directory, params.name)
          const guessed = path.relative(instance.directory, guess)
          // the seconds of the picture count from here, not from the wait for the permission
          yield* ctx.metadata({ title: guessed, metadata: { file: guess, width, height, began: Date.now() } })

          const drawn = yield* draw(
            { prompt: params.prompt, width, height, file: guess },
            {
              report: (job, began) =>
                ctx.metadata({
                  title: job.status === "drawing" ? `${guessed} (${job.step}/${job.steps})` : guessed,
                  metadata: pictureState(job, began, { file: guess, width, height }),
                }),
              aborted: () => ctx.abort.aborted,
            },
          )
          // The name was free when it was chosen; the app says the one the picture really has.
          const file = drawn.file
          const shown = path.relative(instance.directory, file)

          // The picture goes with the result: the user sees it in the chat, and so does a model that reads images
          // (a model that does not is told so where the result is handed to it).
          const model = ctx.extra?.["model"] as Provider.Model | undefined
          return {
            title: shown,
            output: pictureOutput(shown, width, height, model?.capabilities.input.image === true),
            metadata: { file, width, height, seed: drawn.job.seed, model: drawn.job.model, began: drawn.began },
            attachments: [pictureFilePart(file, drawn.png)],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/**
 * Fails with the sentence for the user when this agent was not started by the app: there is no control server to ask,
 * and the tool is not offered then. The picture turn of a session can still be asked for.
 */
export function requireApp(): Effect.Effect<void, Error> {
  return process.env.MANGO_CONTROL_URL
    ? Effect.void
    : Effect.fail(new Error("Pictures are made by the Mango Code app, and this agent was not started by it."))
}

/** The largest seed the app takes: it keeps it in 32 bits, unsigned. */
export const MAX_SEED = 2 ** 32 - 1

/** What to ask the app for: the description is the image model's, as it is; the file is where the picture is written. */
export type Drawing = {
  prompt: string
  width: number
  height: number
  file: string
  /** Key of the image model; without it the app's default. */
  model?: string
  seed?: number
  /** Keep the image engine on after the picture: for a run of pictures. */
  stayOn?: boolean
}

/**
 * What the row of the picture in the conversation is told while the job goes on: the stage it is at, and `began`, the
 * moment its own turn came (none while it waits in the line), from which the row counts its seconds.
 */
export function pictureState(
  job: Pick<Job, "status" | "step" | "steps"> & { preview?: string | null },
  began: number | undefined,
  shown: { file: string; width: number; height: number },
) {
  return {
    stage: job.status,
    step: job.step,
    steps: job.steps,
    preview: job.preview ?? null,
    began,
    ...shown,
  }
}

/**
 * Asks the app for the picture and waits for it. `report` is told the state of the job, and when its turn came, each
 * time it changes while it has not ended; `aborted` is asked at every look, and a picture whose turn was stopped is
 * cancelled. The job is cancelled
 * on every way out except its own ending (done, failed or cancelled by someone else): an interruption, or a failure
 * to follow it, would otherwise leave the app drawing a picture nobody waits for, with the next one in line behind it.
 * `file` of the result is where the app really wrote the picture. Fails with the sentence for the user.
 */
export function draw(
  drawing: Drawing,
  options: { report: (job: Job, began: number | undefined) => Effect.Effect<void>; aborted?: () => boolean },
): Effect.Effect<{ job: Job; png: string; file: string; began: number | undefined }, Error> {
  return Effect.gen(function* () {
    yield* requireApp()
    const asked = yield* control("POST", "/control/image/generate", Job, {
      prompt: drawing.prompt,
      width: drawing.width,
      height: drawing.height,
      file: drawing.file,
      model: drawing.model,
      seed: drawing.seed,
      stay_on: drawing.stayOn,
    })
    const cancel = control("POST", `/control/image/jobs/${asked.id}/cancel`, Job, undefined, LIMIT.cancel).pipe(
      Effect.ignore,
    )
    const followed = yield* follow(asked.id, options).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : cancel)),
    )
    const job = followed.job

    if (job.status === "cancelled") return yield* Effect.fail(new Error("The picture was stopped."))
    if (job.status === "failed")
      return yield* Effect.fail(
        // the app's detail may begin with the sentence itself
        new Error(
          job.error && job.detail?.startsWith(job.error)
            ? job.detail
            : [job.error ?? "The picture could not be made.", job.detail].filter(Boolean).join(" "),
        ),
      )
    const picture = yield* control("GET", `/control/image/jobs/${job.id}/picture`, Picture, undefined, LIMIT.picture)
    return { job, png: picture.png, file: job.file ?? drawing.file, began: followed.began }
  })
}

/** The picture as the file attachment of a result. */
export function pictureFilePart(file: string, png: string) {
  return {
    type: "file" as const,
    mime: "image/png",
    filename: path.basename(file),
    url: `data:image/png;base64,${png}`,
  }
}

/**
 * The text of a result: what was made. For a model that asked for the picture and reads images, `lookAtIt` adds the
 * request to check it and make it again if it is not what was asked; where the person asked and judges the picture
 * themselves, the result only says what was made.
 */
export function pictureOutput(shown: string, width: number, height: number, lookAtIt = false) {
  return lookAtIt
    ? `Picture saved as ${shown} (${width}x${height}). Look at it: if it is not what was asked, make it again with a better description.`
    : `Picture saved as ${shown} (${width}x${height}).`
}

/**
 * The job when it has ended, asked again and again, and the moment it was first seen out of the line (`began`). The
 * app makes one picture at a time: a job that is still `waiting` has not started, and its seconds are not yet counted.
 * `told` is what the last report said: the report is made when the job is not what it was.
 */
function follow(
  id: string,
  options: { report: (job: Job, began: number | undefined) => Effect.Effect<void>; aborted?: () => boolean },
  since?: number,
  told?: string,
): Effect.Effect<{ job: Job; began: number | undefined }, Error> {
  return Effect.gen(function* () {
    if (options.aborted?.()) return yield* Effect.fail(new Error("The picture was stopped."))
    const job = yield* control("GET", `/control/image/jobs/${id}`, Job)
    const began = since ?? (job.status === "waiting" ? undefined : Date.now())
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return { job, began }
    const now = `${job.status}/${job.step}/${job.steps}/${job.preview ?? ""}`
    if (now !== told) yield* options.report(job, began)
    yield* Effect.sleep(EVERY)
    return yield* follow(id, options, began, now)
  })
}

/**
 * A request to the app's control server: its answer in the shape asked, or its own sentence as the error. It is given
 * up after `limit` milliseconds, answer included: a server that takes the connection and says nothing is as good as
 * one that is not there.
 */
function control<A>(
  method: "GET" | "POST",
  pathname: string,
  shape: Schema.Decoder<A>,
  body?: unknown,
  limit: number = LIMIT.call,
) {
  return Effect.tryPromise({
    try: (signal) =>
      fetch(new URL(pathname, process.env.MANGO_CONTROL_URL), {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(limit)]),
      }).then(async (response) => ({ ok: response.ok, json: (await response.json()) as unknown })),
    catch: () => new Error("The Mango Code app is not answering: pictures are made by the app."),
  }).pipe(
    Effect.flatMap((answer) =>
      answer.ok
        ? Schema.decodeUnknownEffect(shape)(answer.json).pipe(
            Effect.mapError(() => new Error("The Mango Code app gave an answer this tool does not understand.")),
          )
        : Effect.fail(
            new Error(
              Schema.decodeUnknownOption(Failure)(answer.json).pipe(
                Option.map((failure) => failure.error.message),
                Option.getOrElse(() => "The Mango Code app refused the request."),
              ),
            ),
          ),
    ),
  )
}

/** A name a file can have: lowercase letters, digits and dashes. */
export function fileName(name: string) {
  const clean =
    name
      .toLowerCase()
      .replace(/\.png$/, "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || tr("immagine", "picture")
  // Windows does not let a file have one of these names, whatever its extension.
  return RESERVED.test(clean) ? `${clean}-${tr("immagine", "picture")}` : clean
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/** Where the picture called `name` goes: the pictures' folder of the working folder, a file that is not there yet. */
export function pictureFile(fs: FSUtil.Interface, directory: string, name: string) {
  return free(fs, path.join(directory, tr("immagini", "images")), fileName(name))
}

/** The first of `name.png`, `name-2.png`, … that is not there: a picture never replaces another. */
function free(fs: FSUtil.Interface, folder: string, name: string, n = 1): Effect.Effect<string> {
  return Effect.gen(function* () {
    const file = path.join(folder, n === 1 ? `${name}.png` : `${name}-${n}.png`)
    return (yield* fs.existsSafe(file)) ? yield* free(fs, folder, name, n + 1) : file
  })
}
