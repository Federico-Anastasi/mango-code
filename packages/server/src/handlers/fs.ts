import { FileSystem } from "@opencode-ai/core/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { download } from "../content-headers"
import { response } from "../location"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const requested = decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13))
          const file = yield* (yield* FileSystem.Service).read({ path: RelativePath.make(requested) })
          const { "content-type": contentType, ...headers } = download({ path: requested, mime: file.mime })
          return HttpServerResponse.uint8Array(file.content, { contentType, headers })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
  }),
)
