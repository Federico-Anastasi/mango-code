import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import path from "path"
import { rm } from "fs/promises"
import type { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstancesEffect, provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(SystemPrompt.node, [[MCP.node, Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })]]),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const writeSkill = (dir: string, name: string) =>
  Effect.promise(() =>
    Bun.write(
      path.join(dir, ".opencode", "skill", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: Skill ${name}.\n---\n\n# ${name}\n`,
    ),
  )

const removeSkill = (dir: string, name: string) =>
  Effect.promise(() => rm(path.join(dir, ".opencode", "skill", name), { recursive: true }))

// The text of the system prompt that lists the skills, as one turn of a conversation sends it.
const turn = (sessionID: string) =>
  SystemPrompt.Service.use((prompt) => prompt.skills(build, sessionID)).pipe(Effect.map((text) => text ?? ""))

describe("session.system skills across conversations", () => {
  it.live("a new conversation sees the skills of that moment, the one in progress keeps its list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "old-skill")
          yield* writeSkill(dir, "kept-skill")

          const first = yield* turn("ses_a")
          expect(first).toContain("<name>old-skill</name>")

          // The project changes on disk while the app stays open.
          yield* removeSkill(dir, "old-skill")
          yield* writeSkill(dir, "new-skill")

          // (b) The conversation already begun: the text of the second turn is the one of the first, byte for byte.
          expect(yield* turn("ses_a")).toBe(first)

          // (a) A new conversation: the added skill is there, the removed one is not.
          const fresh = yield* turn("ses_b")
          expect(fresh).toContain("<name>new-skill</name>")
          expect(fresh).toContain("<name>kept-skill</name>")
          expect(fresh).not.toContain("<name>old-skill</name>")

          // The first conversation is still not touched by the second one.
          expect(yield* turn("ses_a")).toBe(first)
        }),
      { git: true },
    ),
  )

  it.live("a conversation resumed after the agent restarts sees the current list, as before", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "old-skill")
          const before = yield* turn("ses_a")
          expect(before).toContain("<name>old-skill</name>")

          yield* removeSkill(dir, "old-skill")
          yield* writeSkill(dir, "new-skill")
          yield* disposeAllInstancesEffect

          const resumed = yield* turn("ses_a")
          expect(resumed).toContain("<name>new-skill</name>")
          expect(resumed).not.toContain("<name>old-skill</name>")
        }),
      { git: true },
    ),
  )

  it.live("the lists kept for conversations are bounded: the oldest is let go", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* writeSkill(dir, "old-skill")
          const first = yield* turn("ses_0")
          for (let i = 1; i <= 64; i++) yield* turn(`ses_${i}`)

          yield* removeSkill(dir, "old-skill")
          yield* writeSkill(dir, "new-skill")

          // ses_0 was the oldest of 65 conversations: it is read again, like a conversation new to this agent.
          expect(yield* turn("ses_0")).not.toBe(first)
          // The most recent one is still kept.
          expect(yield* turn("ses_64")).toContain("<name>old-skill</name>")
        }),
      { git: true },
    ),
  )
})
