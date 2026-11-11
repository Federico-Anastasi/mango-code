import { describe, expect } from "bun:test"
import { Project } from "@/project/project"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// mango-code: with MANGO_PROJECTS_GIT the app makes every folder it opens a repository with a first commit.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, CrossSpawnSpawner.node])))

const withProjectsGit = Effect.acquireRelease(
  Effect.sync(() => {
    const before = process.env.MANGO_PROJECTS_GIT
    process.env.MANGO_PROJECTS_GIT = "1"
    return before
  }),
  (before) =>
    Effect.sync(() => {
      if (before === undefined) delete process.env.MANGO_PROJECTS_GIT
      else process.env.MANGO_PROJECTS_GIT = before
    }),
)

const commits = (directory: string) => $`git rev-list --all`.cwd(directory).quiet().nothrow().text()

describe("Project.fromDirectory with MANGO_PROJECTS_GIT", () => {
  it.live("an empty folder becomes a repository with a first commit", () =>
    Effect.gen(function* () {
      yield* withProjectsGit
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()

      yield* project.fromDirectory(tmp)

      expect(yield* Effect.promise(() => fs.stat(path.join(tmp, ".git")))).toBeDefined()
      expect((yield* Effect.promise(() => commits(tmp))).trim().split("\n")).toHaveLength(1)
    }),
  )

  it.live("a folder too broad to be a project (here, the OneDrive folder) is never turned into a repository", () =>
    Effect.gen(function* () {
      yield* withProjectsGit
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const before = process.env.OneDrive
          process.env.OneDrive = tmp
          return before
        }),
        (before) =>
          Effect.sync(() => {
            if (before === undefined) delete process.env.OneDrive
            else process.env.OneDrive = before
          }),
      )

      yield* project.fromDirectory(tmp)

      expect(yield* Effect.promise(() => fs.stat(path.join(tmp, ".git")).catch(() => undefined))).toBeUndefined()
    }),
  )

  it.live("a folder that holds repositories is not turned into one around them", () =>
    Effect.gen(function* () {
      yield* withProjectsGit
      const project = yield* Project.Service
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init -q a`.cwd(tmp).quiet())

      yield* project.fromDirectory(tmp)

      expect(yield* Effect.promise(() => fs.stat(path.join(tmp, ".git")).catch(() => undefined))).toBeUndefined()
    }),
  )
})
