import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const opts = yield* resolveNetworkOptions(args)
    // mango-code: no password is normal on 127.0.0.1 (CORS accepts only local pages); the warning
    // stays for anyone who exposes the server to the network.
    const local = ["127.0.0.1", "localhost", "::1"].includes(String(opts.hostname))
    if (!Flag.OPENCODE_SERVER_PASSWORD && !local) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`Mango Code server listening on http://${server.hostname}:${server.port}`)

    yield* Effect.never
  }),
})
