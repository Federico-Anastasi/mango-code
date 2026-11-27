import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionPrompt } from "../../src/session/prompt"
import { Harness } from "../../src/session/harness"
import { testEffect } from "../lib/effect"

// mango-code: the settings page shows the weights of the model that measured last, which can differ from the default
// one; their fingerprints are those of that model's request, so the items it lists must be of that model too.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([SessionPrompt.node])))

const model = { tool_call: true, attachment: false, temperature: true, limit: { context: 32768, output: 4096 } }
const config = {
  enabled_providers: ["mango"],
  model: "mango/local",
  provider: {
    mango: {
      name: "mango-code",
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "dummy", baseURL: "http://127.0.0.1:9/v1" },
      models: { local: { name: "local", ...model }, other: { name: "other", ...model } },
    },
  },
}

const base = (listed: SessionPrompt.PromptItems) => listed.items.find((item) => item.kind === "base")?.text ?? ""

describe("the prompt items of the settings page", () => {
  it.instance(
    "are those of the model asked for when it is a local one, else of the default model",
    () =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const other = yield* prompt.items("other")
        expect(other.model).toBe("other")
        expect(base(other)).toContain("mango/other")
        const unknown = yield* prompt.items("gone")
        expect(unknown.model).toBe("local")
        expect(base(unknown)).toContain("mango/local")
      }),
    { git: true, config },
    60_000,
  )

  it.instance(
    "are those of the harness the page shows, also one that no model uses",
    () =>
      Effect.gen(function* () {
        const saved = process.env.MANGO_SETTINGS
        const data = fs.mkdtempSync(path.join(os.tmpdir(), "items-"))
        const own = path.join(data, "harness", "mine")
        fs.mkdirSync(own, { recursive: true })
        fs.writeFileSync(path.join(own, "harness.json"), JSON.stringify({ name: "Mine", from: "mango-harness-1" }))
        fs.writeFileSync(path.join(own, "prompt.md"), "A base prompt of the user's own.")
        process.env.MANGO_SETTINGS = path.join(data, "settings.json")
        Harness.forget()
        try {
          const prompt = yield* SessionPrompt.Service
          expect(base(yield* prompt.items("local", "mine"))).toContain("A base prompt of the user's own.")
          expect(base(yield* prompt.items("local"))).not.toContain("A base prompt of the user's own.")
        } finally {
          if (saved === undefined) delete process.env.MANGO_SETTINGS
          else process.env.MANGO_SETTINGS = saved
          Harness.unwatch()
          Harness.forget()
          fs.rmSync(data, { recursive: true, force: true })
        }
      }),
    { git: true, config },
    60_000,
  )
})
