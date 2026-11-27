import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Effect } from "effect"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "@/util/token"
import { Harness } from "../../src/session/harness"
import { provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"

import { Provider } from "@/provider/provider"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Usage } from "@opencode-ai/llm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const usage = (input: ConstructorParameters<typeof Usage>[0]) => new Usage(input)

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
  image?: boolean
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: opts.image ?? false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

function createUserMessage(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function createAssistantMessage(sessionID: SessionID, parentID: MessageID, root: string) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

const compactionTestNode = LayerNode.group([
  SessionCompaction.node,
  SessionNs.node,
  SessionProjector.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])
const env = AppNodeBuilder.build(compactionTestNode, [
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
])

const it = testEffect(env)

describe("session.compaction.isOverflow", () => {
  const at = (input: number, cache = 0) => ({ input, output: 0, reasoning: 0, cache: { read: cache, write: 0 } })

  it.live(
    "is true once 90% of the context is used, and not before",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(yield* compact.isOverflow({ tokens: at(89_999), model })).toBe(false)
        expect(yield* compact.isOverflow({ tokens: at(90_000), model })).toBe(true)
      }),
    ),
  )

  it.live(
    "on a small context keeps at least the room to reason and write a summary",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 32_768, output: 32_768 })
        expect(yield* compact.isOverflow({ tokens: at(24_575), model })).toBe(false)
        expect(yield* compact.isOverflow({ tokens: at(24_576), model })).toBe(true)
      }),
    ),
  )

  it.live(
    "keeps back nothing for the length of an answer: the limit of the output of the model plays no part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        for (const output of [0, 4_096, 32_000]) {
          const model = createModel({ context: 100_000, output })
          expect(yield* compact.isOverflow({ tokens: at(85_000), model })).toBe(false)
          expect(yield* compact.isOverflow({ tokens: at(90_000), model })).toBe(true)
        }
      }),
    ),
  )

  it.live(
    "includes cache.read in token count",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 100_000, output: 32_000 })
        expect(yield* compact.isOverflow({ tokens: at(60_000, 40_000), model })).toBe(true)
      }),
    ),
  )

  it.live(
    "respects the input limit of a model that has one",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
        expect(yield* compact.isOverflow({ tokens: at(270_000, 2_000), model })).toBe(true)
        expect(yield* compact.isOverflow({ tokens: at(200_000, 10_000), model })).toBe(false)
      }),
    ),
  )

  it.live(
    "keeps back what the configuration reserves instead",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          expect(yield* compact.isOverflow({ tokens: at(79_999), model })).toBe(false)
          expect(yield* compact.isOverflow({ tokens: at(80_000), model })).toBe(true)
        }),
      { config: { compaction: { reserved: 20_000 } } },
    ),
  )

  it.live(
    "returns false when model context limit is 0",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const model = createModel({ context: 0, output: 32_000 })
        expect(yield* compact.isOverflow({ tokens: at(110_000), model })).toBe(false)
      }),
    ),
  )

  it.live(
    "returns false when compaction.auto is disabled",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          expect(yield* compact.isOverflow({ tokens: at(99_000), model })).toBe(false)
        }),
      {
        config: {
          compaction: { auto: false },
        },
      },
    ),
  )
})

describe("session.compaction.create", () => {
  it.live(
    "creates a compaction user message and part",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service

        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
        })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        expect(msgs).toHaveLength(1)
        expect(msgs[0].info.role).toBe("user")
        expect(msgs[0].parts).toHaveLength(1)
        expect(msgs[0].parts[0]).toMatchObject({
          type: "compaction",
          auto: true,
        })
      }),
    ),
  )

  it.live.skip(
    "projects a compaction message to v2 (v2 projector disabled)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        yield* compact.create({
          sessionID: info.id,
          agent: "build",
          model: ref,
          auto: true,
        })

        const v2 = yield* SessionV2.Service.use((svc) => svc.messages({ sessionID: info.id })).pipe(
          Effect.provide(AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])),
        )
        expect(v2.at(-1)).toMatchObject({
          type: "compaction",
          reason: "auto",
          summary: "",
        })
      }),
    ),
  )
})

describe("session.compaction.prune", () => {
  it.live(
    "a message that takes up a cut answer is not a turn of its own: the turn before keeps its tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const user = (text: string, resume?: string) =>
            Effect.gen(function* () {
              const msg = yield* ssn.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: info.id,
                agent: "build",
                model: ref,
                time: { created: Date.now() },
              })
              yield* ssn.updatePart({
                id: PartID.ascending(),
                messageID: msg.id,
                sessionID: info.id,
                type: "text",
                text,
                ...(resume ? { synthetic: true, metadata: { resume } } : {}),
              })
              return msg
            })
          const first = yield* user("first")
          const answer = yield* createAssistantMessage(info.id, first.id, dir)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: answer.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          yield* user("second")
          yield* user("Your answer was cut: go on.", "length")

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type === "tool" && part.state.status === "completed" && part.state.time.compacted).toBeFalsy()
        }),
      { config: { compaction: { prune: true } } },
    ),
  )

  it.live(
    "compacts old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const a = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: "first",
          })
          const b: SessionV1.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: info.id,
            mode: "build",
            agent: "build",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: a.id,
            time: { created: Date.now() },
            finish: "end_turn",
          }
          yield* ssn.updateMessage(b)
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: b.id,
            sessionID: info.id,
            type: "tool",
            callID: crypto.randomUUID(),
            tool: "bash",
            state: {
              status: "completed",
              input: {},
              output: "x".repeat(200_000),
              title: "done",
              metadata: {},
              time: { start: Date.now(), end: Date.now() },
            },
          })
          for (const text of ["second", "third"]) {
            const msg = yield* ssn.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: info.id,
              agent: "build",
              model: ref,
              time: { created: Date.now() },
            })
            yield* ssn.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: info.id,
              type: "text",
              text,
            })
          }

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeNumber()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const compact = yield* SessionCompaction.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const a = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: a.id,
          sessionID: info.id,
          type: "text",
          text: "first",
        })
        const b: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          mode: "build",
          agent: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: a.id,
          time: { created: Date.now() },
          finish: "end_turn",
        }
        yield* ssn.updateMessage(b)
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: b.id,
          sessionID: info.id,
          type: "tool",
          callID: crypto.randomUUID(),
          tool: "skill",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(200_000),
            title: "done",
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
        })
        for (const text of ["second", "third"]) {
          const msg = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: info.id,
            type: "text",
            text,
          })
        }

        yield* compact.prune({ sessionID: info.id })

        const msgs = yield* ssn.messages({ sessionID: info.id })
        const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
        expect(part?.type).toBe("tool")
        if (part?.type === "tool" && part.state.status === "completed") {
          expect(part.state.time.compacted).toBeUndefined()
        }
      }),
    ),
  )
})

const texts = Harness.definition("mango-harness-2").compaction

/** An assistant message with one completed call of a tool; `output` is as long as the test needs the message to weigh. */
function createCall(
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
  call: { tool: string; input: Record<string, unknown>; output: string; finish?: string },
) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: call.finish ?? "tool-calls",
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "tool",
      callID: `call-${msg.id}`,
      tool: call.tool,
      state: {
        status: "completed",
        input: call.input,
        output: call.output,
        title: call.tool,
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    return msg
  })
}

/** A request for a summary and the model's answer to it, with `text` as the summary. */
function askForSummary(
  sessionID: SessionID,
  root: string,
  answer: { text: string; finish?: string; error?: SessionV1.Assistant["error"] },
) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const ask = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      model: ref,
      sessionID,
      agent: "build",
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: ask.id,
      sessionID,
      type: "compaction",
      auto: true,
    })
    const reply = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "compaction",
      agent: "build",
      path: { cwd: root, root },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: ask.id,
      summary: true,
      time: { created: Date.now() },
      finish: answer.finish ?? "stop",
      ...(answer.error ? { error: answer.error } : {}),
    })
    yield* ssn.updatePart({ id: PartID.ascending(), messageID: reply.id, sessionID, type: "text", text: answer.text })
    return { ask, reply }
  })
}

const BIG = "x".repeat(40_000)
const model = createModel({ context: 100_000, output: 32_000 })
const finish = (input: { sessionID: SessionID; root: string; ask: SessionV1.User; reply: SessionV1.Assistant }) =>
  SessionCompaction.use.complete({
    sessionID: input.sessionID,
    parentID: input.ask.id,
    message: input.reply,
    result: "continue",
    model,
    texts,
    project: input.root,
  })

describe("session.compaction.complete", () => {
  it.instance("keeps the tail, the user's messages and the last skill, and writes what the model reads after the summary", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "first request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "src/a.ts" }, output: BIG })
      const two = yield* createUserMessage(session.id, "second request")
      const skill = yield* createCall(session.id, two.id, directory, { tool: "skill", input: { name: "testing" }, output: BIG })
      const three = yield* createUserMessage(session.id, "third request")
      const last = yield* createCall(session.id, three.id, directory, { tool: "write", input: { path: "src/b.ts" }, output: BIG })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "## Objective\n- do the thing" })

      const done = yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })
      expect(done).toBe("continue")

      const all = yield* ssn.messages({ sessionID: session.id })
      const part = all.find((item) => item.info.id === ask.id)!.parts[0] as SessionV1.CompactionPart
      expect(part.tail_start_id).toBe(last.id)
      expect(part.users_from_id).toBe(two.id)

      const written = all.at(-1)!
      expect(written.info.role).toBe("user")
      const text = written.parts.map((item) => (item.type === "text" ? item.text : "")).join("\n")
      expect(text).toStartWith(texts.continued)
      expect(text).toContain("## Objective\n- do the thing")
      expect(text).toContain(`${texts["files-read"]}\n- src/a.ts`)
      expect(text).toContain(`${texts["files-changed"]}\n- src/b.ts`)
      expect(written.parts).toHaveLength(1)

      const seen = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      expect(seen.map((item) => item.info.id).filter((id) => id !== ask.id && id !== reply.id)).toEqual([
        one.id,
        two.id,
        three.id,
        skill.id,
        written.info.id,
        last.id,
      ])
      // only the call of the skill comes back from the message that held it
      expect(seen.find((item) => item.info.id === skill.id)!.parts).toHaveLength(1)
    }),
  )

  it.instance("says how many messages of the user are left out when they do not fit", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const users: { id: MessageID }[] = []
      for (const n of [1, 2, 3, 4, 5]) {
        // about 2,750 tokens each: the first and one more fit in 6,000
        const user = yield* createUserMessage(session.id, `request ${n} ${"y".repeat(11_000)}`)
        users.push(user)
        yield* createCall(session.id, user.id, directory, { tool: "terminal", input: { command: "ls" }, output: "ok" })
      }
      const end = yield* createCall(session.id, users[4]!.id, directory, { tool: "terminal", input: { command: "ls" }, output: BIG })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "summary" })
      yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })

      const all = yield* ssn.messages({ sessionID: session.id })
      const part = all.find((item) => item.info.id === ask.id)!.parts[0] as SessionV1.CompactionPart
      expect(part.tail_start_id).toBe(end.id)
      expect(part.users_from_id).toBe(users[4]!.id)

      const seen = MessageV2.filterCompacted(yield* MessageV2.stream(session.id))
      const model = yield* MessageV2.toModelMessagesEffect(seen, createModel({ context: 100_000, output: 32_000 }))
      const asText = (content: unknown) =>
        typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((item) => item.text ?? "").join("\n")
      const first = asText(model[0]!.content)
      expect(first).toContain("request 1 ")
      expect(first).toContain(texts.missing.replace("{{missing}}", "3"))
      expect(first).toContain("request 5 ")
      expect(first).not.toContain("request 2 ")
    }),
  )

  it.instance("on a small context the tail kept after the summary is smaller", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      // about 3,000 tokens each: two fit in the tail of a large context, one in the tail of a 32K one
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "z".repeat(12_000) })
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "b.ts" }, output: "z".repeat(12_000) })
      const last = yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "c.ts" }, output: "z".repeat(12_000) })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "summary" })
      yield* SessionCompaction.use.complete({
        sessionID: session.id,
        parentID: ask.id,
        message: reply as SessionV1.Assistant,
        result: "continue",
        model: createModel({ context: 32_768, output: 32_768 }),
        texts,
        project: directory,
      })
      const part = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.id === ask.id)!.parts[0] as SessionV1.CompactionPart
      expect(part.tail_start_id).toBe(last.id)
    }),
  )

  it.instance("goes on from the last result when the work was half way, and stops when the turn had ended", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      const answer = yield* createAssistantMessage(session.id, one.id, directory)
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: answer.id, sessionID: session.id, type: "text", text: "all done" })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "summary" })

      expect(yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })).toBe("stop")
      // no message asks the model to go on: the next message is the user's
      const all = yield* ssn.messages({ sessionID: session.id })
      expect(all.filter((item) => item.info.role === "user").map((item) => item.parts[0]?.type)).toEqual(["text", "compaction", "text"])
    }),
  )

  it.instance("goes on after an answer that was cut because the context was full", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      const answer = yield* createAssistantMessage(session.id, one.id, directory)
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: answer.id, sessionID: session.id, type: "text", text: "a long file, written until" })
      yield* ssn.updateMessage({ ...answer, finish: "context" })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "summary" })

      expect(yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })).toBe("continue")
    }),
  )

  it.instance("a summary cut for going on with blank lines is a finished summary", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "ok" })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "summary of the work" })
      // the cut stops the stream before its last step: the answer has no finish of its own
      const cut = { ...(reply as SessionV1.Assistant), finish: undefined }
      yield* ssn.updateMessage(cut)
      const done = yield* SessionCompaction.use.complete({
        sessionID: session.id,
        parentID: ask.id,
        message: cut,
        result: "blank",
        model,
        texts,
        project: directory,
      })
      expect(done).toBe("continue")
      const stored = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.id === reply.id)!.info as SessionV1.Assistant
      expect(stored.finish).toBe("stop")
      expect(stored.error).toBeUndefined()
    }),
  )

  it.instance("a summary longer than the room kept for it is kept, since the engine finished it", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "ok" })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "z".repeat(5_000 * 4) })

      expect(yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })).toBe("continue")
      const stored = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.id === reply.id)!.info as SessionV1.Assistant
      expect(stored.error).toBeUndefined()
    }),
  )

  it.instance("without a summary of the model's the agent writes one from the calls, and the work goes on", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      for (const [result, answer] of [
        ["repeat", { text: "summary of the work summary of the work" }],
        ["called", { text: "" }],
        ["compact", { text: "" }],
        ["continue", { text: "  " }],
        ["continue", { text: "half a summ", finish: "length" }],
        ["stop", { text: "", error: new SessionV1.APIError({ message: "conversation roles must alternate", isRetryable: false }).toObject() }],
      ] as const) {
        const session = yield* ssn.create({})
        const one = yield* createUserMessage(session.id, "request")
        yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "first lines of a.ts" })
        yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "b.ts" }, output: BIG })
        const { ask, reply } = yield* askForSummary(session.id, directory, answer)
        const done = yield* SessionCompaction.use.complete({
          sessionID: session.id,
          parentID: ask.id,
          message: reply as SessionV1.Assistant,
          result,
          model: createModel({ context: 32_768, output: 4_096 }),
          texts,
          project: directory,
        })
        expect(done).toBe("continue")
        const all = yield* ssn.messages({ sessionID: session.id })
        const stored = all.find((item) => item.info.id === reply.id)!
        expect((stored.info as SessionV1.Assistant).error).toBeUndefined()
        expect((stored.info as SessionV1.Assistant).finish).toBe("stop")
        const written = stored.parts.filter((part): part is SessionV1.TextPart => part.type === "text")
        expect(written).toHaveLength(1)
        expect(written[0]!.text).toStartWith(texts.unwritten)
        // the call before the last messages, with the start of its answer; the last one stays as it was after the summary
        expect(written[0]!.text).toContain('- read {"path":"a.ts"}\n  → first lines of a.ts')
        expect(written[0]!.text).not.toContain("b.ts")
        const told = all.at(-1)!.parts.find((part): part is SessionV1.TextPart => part.type === "text")!
        expect(told.text).toStartWith(texts.continued)
        expect(told.text).toContain(texts.unwritten)
      }
    }),
  )

  it.instance("a summary the agent writes carries the summary before it", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "ok" })
      const earlier = yield* askForSummary(session.id, directory, { text: "## Objective\n- EARLIER SUMMARY" })
      yield* finish({ sessionID: session.id, root: directory, ask: earlier.ask as SessionV1.User, reply: earlier.reply })
      const two = yield* createUserMessage(session.id, "go on")
      yield* createCall(session.id, two.id, directory, { tool: "read", input: { path: "c.ts" }, output: "ok" })
      yield* createCall(session.id, two.id, directory, { tool: "read", input: { path: "d.ts" }, output: BIG })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "" })
      yield* SessionCompaction.use.complete({
        sessionID: session.id,
        parentID: ask.id,
        message: reply as SessionV1.Assistant,
        result: "called",
        model: createModel({ context: 32_768, output: 4_096 }),
        texts,
        project: directory,
      })
      const stored = (yield* ssn.messages({ sessionID: session.id })).find((item) => item.info.id === reply.id)!
      const text = (stored.parts.find((part) => part.type === "text") as SessionV1.TextPart).text
      expect(text).toContain("## Objective\n- EARLIER SUMMARY")
      expect(text).toContain('- read {"path":"c.ts"}')
      expect(text).not.toContain("a.ts")
    }),
  )

  it.instance("a summary the user stopped writes nothing", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "a.ts" }, output: "ok" })
      const { ask, reply } = yield* askForSummary(session.id, directory, { text: "", error: MessageV2.abortedError(ref.providerID) })
      expect(yield* finish({ sessionID: session.id, root: directory, ask: ask as SessionV1.User, reply })).toBe("stop")
      const all = yield* ssn.messages({ sessionID: session.id })
      expect(all.at(-1)!.info.id).toBe(reply.id)
      expect((all.at(-1)!.info as SessionV1.Assistant).error?.name).toBe("MessageAbortedError")
    }),
  )

  it.instance("a second summary keeps only what came after the first one, and the files of the whole conversation", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({})
      const one = yield* createUserMessage(session.id, "first request")
      yield* createCall(session.id, one.id, directory, { tool: "read", input: { path: "old.ts" }, output: BIG })
      const firstAsk = yield* askForSummary(session.id, directory, { text: "first summary" })
      yield* finish({ sessionID: session.id, root: directory, ask: firstAsk.ask as SessionV1.User, reply: firstAsk.reply })

      const two = yield* createUserMessage(session.id, "second request")
      yield* createCall(session.id, two.id, directory, { tool: "edit", input: { filePath: path.join(directory, "new.ts") }, output: BIG })
      const end = yield* createCall(session.id, two.id, directory, { tool: "terminal", input: { command: "ls" }, output: BIG })
      const secondAsk = yield* askForSummary(session.id, directory, { text: "second summary" })
      yield* finish({ sessionID: session.id, root: directory, ask: secondAsk.ask as SessionV1.User, reply: secondAsk.reply })

      const all = yield* ssn.messages({ sessionID: session.id })
      const part = all.find((item) => item.info.id === secondAsk.ask.id)!.parts[0] as SessionV1.CompactionPart
      // nothing from before the first summary is in the tail
      expect(part.tail_start_id).toBe(end.id)
      const text = all
        .at(-1)!
        .parts.map((item) => (item.type === "text" ? item.text : ""))
        .join("")
      expect(text).toContain("second summary")
      expect(text).not.toContain("first summary")
      expect(text).toContain(`${texts["files-read"]}\n- old.ts`)
      expect(text).toContain(`${texts["files-changed"]}\n- new.ts`)
    }),
  )
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 }),
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, reasoningTokens: 100, totalTokens: 1500 }),
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 250_000, totalTokens: 1_000_000 }),
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("ignores malformed cost fields", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    })
    Object.assign(model.cost, { input: {} })

    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(1.5)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1_000_000, outputTokens: 100_000, totalTokens: 1_100_000 }),
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test("uses matching context cost tier before over-200k fallback", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 3,
            output: 4,
            cache: { read: 0.3, write: 1.5 },
            tier: { type: "context", size: 200_000 },
          },
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 100,
          output: 100,
          cache: { read: 100, write: 100 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({
        inputTokens: 650_000,
        outputTokens: 100_000,
        totalTokens: 750_000,
        cacheReadInputTokens: 100_000,
      }),
    })

    expect(result.tokens.input).toBe(550_000)
    expect(result.cost).toBe(2.75 + 0.6 + 0.05)
  })

  test("falls back to over-200k pricing when no cost tier matches", () => {
    const model = createModel({
      context: 1_000_000,
      output: 32_000,
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.5 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 0.5, write: 2.5 },
            tier: { type: "context", size: 500_000 },
          },
        ],
        experimentalOver200K: {
          input: 3,
          output: 4,
          cache: { read: 0.3, write: 1.5 },
        },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 300_000, outputTokens: 100_000, totalTokens: 400_000 }),
    })

    expect(result.cost).toBe(0.9 + 0.4)
  })

  test("computes total from components for anthropic models", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/anthropic" })
    // AI SDK v6: inputTokens includes cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: usage({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadInputTokens: 200 }),
      metadata: { anthropic: { cacheCreationInputTokens: 300 } },
    })

    // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
    // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
    expect(result.tokens.total).toBe(1500)
  })
})
