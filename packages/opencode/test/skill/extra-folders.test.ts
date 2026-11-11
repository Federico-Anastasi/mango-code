import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { FOLDERS_KEY } from "../../src/server/shared/mango-folders"
import { Skill } from "../../src/skill"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// mango-code: the skills of the extra folders an app declares (shared/mango-folders.ts) apply at once, also to an
// instance already loaded.
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const skillFile = (extra: string, name: string) => path.join(extra, ".claude", "skills", name, "SKILL.md")
const writeSkill = (extra: string, name: string, description: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(skillFile(extra, name)), { recursive: true })
    await Bun.write(skillFile(extra, name), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
  })

// The registry is the contract with the mango-project plugin: a map in globalThis under a shared symbol.
const declare = (directory: string, extra: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const registry = ((globalThis as Record<symbol, unknown>)[FOLDERS_KEY] ??= new Map()) as Map<string, string[]>
      registry.set(path.resolve(directory).toLowerCase(), [extra])
      return registry
    }),
    (registry) => Effect.sync(() => registry.delete(path.resolve(directory).toLowerCase())),
  )

describe("skills of the extra folders", () => {
  it.live("a new skill and an edit are seen at once", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const extra = path.join(dir, "method")
          yield* declare(dir, extra)
          const skill = yield* Skill.Service
          yield* writeSkill(extra, "first", "version one")
          const described = (name: string) => skill.get(name).pipe(Effect.map((info) => info?.description))

          expect(yield* described("first")).toBe("version one")
          yield* writeSkill(extra, "first", "version two")
          // an edit that lands in the same millisecond is still an edit: move the time forward
          yield* Effect.promise(() => fs.utimes(skillFile(extra, "first"), new Date(), new Date(Date.now() + 5000)))
          expect(yield* described("first")).toBe("version two")
          yield* writeSkill(extra, "second", "added later")
          expect(yield* described("second")).toBe("added later")
        }),
      { git: true },
    ),
  )
})
