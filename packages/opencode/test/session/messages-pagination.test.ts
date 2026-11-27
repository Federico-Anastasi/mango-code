import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"

import { NotFoundError } from "@/storage/storage"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

// Helper functions using Effect.gen
const fill = Effect.fn("Test.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: `m${i}`,
    })
  }
  return ids
})

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, text?: string) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as SessionV1.Info)
  if (text) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; error?: SessionV1.Assistant["error"] },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as SessionV1.Info)
  return id
})

const addCompactionPart = Effect.fn("Test.addCompactionPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  kept?: { tail?: MessageID; users?: MessageID },
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    ...(kept?.tail ? { tail_start_id: kept.tail } : {}),
    ...(kept?.users ? { users_from_id: kept.users } : {}),
  })
})

/** An answer of the model with its text. */
const addReply = Effect.fn("Test.addReply")(function* (sessionID: SessionID, parentID: MessageID, text: string) {
  const session = yield* SessionNs.Service
  const id = yield* addAssistant(sessionID, parentID, { finish: "end_turn" })
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text })
  return id
})

/** The message the agent writes after a summary: the summary, and the line about the messages left out when there is one. */
const addTold = Effect.fn("Test.addTold")(function* (sessionID: SessionID, text: string, note?: string) {
  const session = yield* SessionNs.Service
  const id = yield* addUser(sessionID)
  const write = (what: "summary" | "missing", value: string) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text: value,
      synthetic: true,
      metadata: { resume: "compaction", compaction: what },
    })
  yield* write("summary", text)
  if (note) yield* write("missing", note)
  return id
})

describe("MessageV2.page", () => {
  it.instance("returns page result", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 2)

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result).toBeDefined()
        expect(result.items).toBeArray()
      }),
    ),
  )

  it.instance("pages backward with opaque cursors", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 6)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.items.every((item) => item.parts.length === 1)).toBe(true)
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(b.more).toBe(true)
        expect(b.cursor).toBeTruthy()

        const c = yield* MessageV2.page({ sessionID, limit: 2, before: b.cursor! })
        expect(c.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(c.more).toBe(false)
        expect(c.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("returns items in chronological order within a page", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4)

        const result = yield* MessageV2.page({ sessionID, limit: 4 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("returns empty items for session with no messages", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toEqual([])
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(MessageV2.page({ sessionID: fake, limit: 10 }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )

  it.instance("handles exact limit boundary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)

        const result = yield* MessageV2.page({ sessionID, limit: 3 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("limit of 1 returns single newest message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const result = yield* MessageV2.page({ sessionID, limit: 1 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].info.id).toBe(ids[ids.length - 1])
        expect(result.more).toBe(true)
      }),
    ),
  )

  it.instance("hydrates multiple parts per message", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("accepts cursors from fractional timestamps", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, (i: number) => 1000.5 + i)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })

        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
      }),
    ),
  )

  it.instance("messages with same timestamp are ordered by id", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, () => 1000)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.more).toBe(true)

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(b.more).toBe(false)
      }),
    ),
  )

  it.instance("does not return messages from other sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      yield* fill(a.id, 3)
      yield* fill(b.id, 2)

      const resultA = yield* MessageV2.page({ sessionID: a.id, limit: 10 })
      const resultB = yield* MessageV2.page({ sessionID: b.id, limit: 10 })
      expect(resultA.items).toHaveLength(3)
      expect(resultB.items).toHaveLength(2)
      expect(resultA.items.every((item) => item.info.sessionID === a.id)).toBe(true)
      expect(resultB.items.every((item) => item.info.sessionID === b.id)).toBe(true)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("large limit returns all messages without cursor", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 10)

        const result = yield* MessageV2.page({ sessionID, limit: 100 })
        expect(result.items).toHaveLength(10)
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )
})

describe("MessageV2.stream", () => {
  it.instance("yields items newest first", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const items = yield* MessageV2.stream(sessionID)
        expect(items.map((item) => item.info.id)).toEqual(ids.slice().reverse())
      }),
    ),
  )

  it.instance("yields nothing for empty session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(0)
      }),
    ),
  )

  it.instance("yields single message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 1)

        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(1)
        expect(items[0].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("hydrates parts for each yielded message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const items = yield* MessageV2.stream(sessionID)
        for (const item of items) {
          expect(item.parts).toHaveLength(1)
          expect(item.parts[0].type).toBe("text")
        }
      }),
    ),
  )

  it.instance("handles sets exceeding internal page size", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 60)

        const items = yield* MessageV2.stream(sessionID)
        expect(items).toHaveLength(60)
        expect(items[0].info.id).toBe(ids[ids.length - 1])
        expect(items[59].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("returns an Effect", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 1)

        const result = yield* MessageV2.stream(sessionID)
        expect(result).toHaveLength(1)
      }),
    ),
  )
})

describe("MessageV2.parts", () => {
  it.instance("returns parts for a message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.parts(id)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe("text")
        expect((result[0] as SessionV1.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("returns empty array for message with no parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = yield* MessageV2.parts(id)
        expect(result).toEqual([])
      }),
    ),
  )

  it.instance("returns multiple parts in order", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "second",
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "third",
        })

        const result = yield* MessageV2.parts(id)
        expect(result).toHaveLength(3)
        expect((result[0] as SessionV1.TextPart).text).toBe("m0")
        expect((result[1] as SessionV1.TextPart).text).toBe("second")
        expect((result[2] as SessionV1.TextPart).text).toBe("third")
      }),
    ),
  )

  it.instance("returns empty for non-existent message id", () =>
    Effect.gen(function* () {
      yield* SessionNs.Service
      const result = yield* MessageV2.parts(MessageID.ascending())
      expect(result).toEqual([])
    }),
  )

  it.instance("parts contain sessionID and messageID", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.parts(id)
        expect(result[0].sessionID).toBe(sessionID)
        expect(result[0].messageID).toBe(id)
      }),
    ),
  )
})

describe("MessageV2.get", () => {
  it.instance("returns message with hydrated parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.info.sessionID).toBe(sessionID)
        expect(result.info.role).toBe("user")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as SessionV1.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = MessageID.ascending()
        const error = yield* Effect.flip(MessageV2.get({ sessionID, messageID }))
        expect(error).toBeInstanceOf(NotFoundError)
        expect(error.message).toBe(`Message not found: ${messageID}`)
      }),
    ),
  )

  it.instance("scopes by session id", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      const [id] = yield* fill(a.id, 1)

      const error = yield* Effect.flip(MessageV2.get({ sessionID: b.id, messageID: id }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Message not found: ${id}`)
      const result = yield* MessageV2.get({ sessionID: a.id, messageID: id })
      expect(result.info.id).toBe(id)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("returns message with multiple parts", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("returns assistant message with correct role", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const uid = yield* addUser(sessionID, "hello")
        const aid = yield* addAssistant(sessionID, uid)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: aid,
          type: "text",
          text: "response",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: aid })
        expect(result.info.role).toBe("assistant")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as SessionV1.TextPart).text).toBe("response")
      }),
    ),
  )

  it.instance("returns message with zero parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.parts).toEqual([])
      }),
    ),
  )
})

describe("Session.messages", () => {
  it.instance("returns all messages in chronological order across pages", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 55)
        const result = yield* session.messages({ sessionID })
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.messages({ sessionID: fake }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )
})

describe("Session.findMessage", () => {
  it.instance("searches newest-first", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)
        const result = yield* session.findMessage(sessionID, () => true)
        expect(Option.isSome(result) ? result.value.info.id : undefined).toBe(ids.at(-1))
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.findMessage(fake, () => true))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )
})

describe("MessageV2.filterCompacted", () => {
  it.instance("returns all messages when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(5)
        // reversed from newest-first to chronological
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("a session summarised before the agent wrote its own message shows the summary and the tail", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first question")
        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, { tail: u1 })
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: s1, type: "text", text: "summary" })
        const u2 = yield* addUser(sessionID, "new question")
        const a2 = yield* addAssistant(sessionID, u2)

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        // the summary as a message of the user, the tail, then what came after
        expect(result.map((item) => item.info.id)).toEqual([c1, u1, c1, s1, u2, a2])
        expect(result[0].parts[0]).toMatchObject({ type: "text", text: "summary" })
      }),
    ),
  )

  it.live("handles empty iterable", () =>
    Effect.sync(() => {
      const result = MessageV2.filterCompacted([])
      expect(result).toEqual([])
    }),
  )

  it.instance("does not break on compaction part without matching summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        yield* addUser(sessionID, "world")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(2)
      }),
    ),
  )

  it.instance("skips assistant with error even if marked as summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        const error = new SessionV1.APIError({
          message: "boom",
          isRetryable: true,
        }).toObject() as SessionV1.Assistant["error"]
        yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn", error })
        yield* addUser(sessionID, "retry")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        // Error assistant doesn't add to completed, so compaction boundary never triggers
        expect(result).toHaveLength(3)
      }),
    ),
  )

  it.instance("skips assistant without finish even if marked as summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        // summary=true but no finish
        yield* addAssistant(sessionID, u1, { summary: true })
        yield* addUser(sessionID, "next")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))
        expect(result).toHaveLength(3)
      }),
    ),
  )

  it.instance("puts the messages of the user, the message the agent wrote and the tail where the summary was asked", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addReply(sessionID, u1, "first reply")
        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addReply(sessionID, u2, "second reply")
        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, { tail: u2 })
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        const told = yield* addTold(sessionID, "summary")
        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addReply(sessionID, u3, "third reply")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        // the first answer is in the summary; the messages of the user stay, the summary comes before the tail
        expect(result.map((item) => item.info.id)).toEqual([u1, told, u2, a2, c1, s1, u3, a3])
        expect(a1).toBeDefined()
      }),
    ),
  )

  it.instance("a tail that starts inside a turn, and the user's messages that fit after the first", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        yield* addReply(sessionID, u1, "first reply")
        const u2 = yield* addUser(sessionID, "second")
        yield* addReply(sessionID, u2, "second reply")
        const a3 = yield* addReply(sessionID, u2, "tail reply")
        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, { tail: a3, users: u2 })
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        const told = yield* addTold(sessionID, "summary")
        const u3 = yield* addUser(sessionID, "third")
        const a4 = yield* addReply(sessionID, u3, "third reply")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([u1, u2, told, a3, c1, s1, u3, a4])
      }),
    ),
  )

  it.instance("the line about the messages left out comes after the first one", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        yield* addReply(sessionID, u1, "r")
        yield* addUser(sessionID, "second")
        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addReply(sessionID, u3, "r")
        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, { tail: a3, users: u3 })
        yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTold(sessionID, "summary", "1 left out")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        const texts = result.map((item) => item.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))
        expect(texts.slice(0, 4)).toEqual(["first", "1 left out", "third", "summary"])
      }),
    ),
  )

  it.instance("fork remaps the ids the summary keeps", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})

      const u1 = yield* addUser(created.id, "first")
      yield* addReply(created.id, u1, "first reply")
      const u2 = yield* addUser(created.id, "second")
      const a2 = yield* addReply(created.id, u2, "second reply")
      const c1 = yield* addUser(created.id)
      yield* addCompactionPart(created.id, c1, { tail: a2, users: u2 })
      const s1 = yield* addAssistant(created.id, c1, { summary: true, finish: "end_turn" })
      yield* addTold(created.id, "summary")
      const u3 = yield* addUser(created.id, "third")
      yield* addReply(created.id, u3, "third reply")

      const parentFiltered = MessageV2.filterCompacted(yield* MessageV2.stream(created.id))
      expect(parentFiltered.map((item) => item.info.id)).toContain(s1)

      const forked = yield* session.fork({ sessionID: created.id })
      const childFiltered = MessageV2.filterCompacted(yield* MessageV2.stream(forked.id))
      const shape = (items: typeof parentFiltered) =>
        items.map((item) => `${item.info.role}:${item.parts.map((part) => (part.type === "text" ? part.text : part.type)).join("|")}`)
      expect(shape(childFiltered)).toEqual(shape(parentFiltered))

      const part = childFiltered.flatMap((item) => item.parts).find((item) => item.type === "compaction")
      if (!part || part.type !== "compaction") throw new Error("Expected forked compaction part")
      expect(childFiltered.some((item) => item.info.id === part.tail_start_id)).toBe(true)
      expect(childFiltered.some((item) => item.info.id === part.users_from_id)).toBe(true)

      yield* session.remove(forked.id)
      yield* session.remove(created.id)
    }),
  )

  it.instance("the latest summary decides, and what came before the earlier one is not in the tail", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        yield* addReply(sessionID, u1, "first reply")
        const u2 = yield* addUser(sessionID, "second")
        yield* addReply(sessionID, u2, "second reply")
        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, { tail: u2 })
        yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* addTold(sessionID, "summary one")
        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addReply(sessionID, u3, "third reply")
        const c2 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c2, { tail: u3, users: u2 })
        const s2 = yield* addAssistant(sessionID, c2, { summary: true, finish: "end_turn" })
        const told2 = yield* addTold(sessionID, "summary two")
        const u4 = yield* addUser(sessionID, "fourth")
        const a4 = yield* addReply(sessionID, u4, "fourth reply")

        const result = MessageV2.filterCompacted(yield* MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([u1, u2, told2, u3, a3, c2, s2, u4, a4])
      }),
    ),
  )

  test("works with array input", () => {
    // filterCompacted accepts any Iterable, not just generators
    const id = MessageID.ascending()
    const items: SessionV1.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as SessionV1.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as SessionV1.Part[],
      },
    ]
    const result = MessageV2.filterCompacted(items)
    expect(result).toHaveLength(1)
    expect(result[0].info.id).toBe(id)
  })
})

describe("MessageV2.cursor", () => {
  test("encode/decode roundtrip", () => {
    const input = { id: MessageID.ascending(), time: 1234567890 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(input.id)
    expect(decoded.time).toBe(input.time)
  })

  test("encode/decode with fractional time", () => {
    const input = { id: MessageID.ascending(), time: 1234567890.5 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.time).toBe(1234567890.5)
  })

  test("encoded cursor is base64url", () => {
    const encoded = MessageV2.cursor.encode({ id: MessageID.ascending(), time: 0 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("MessageV2 consistency", () => {
  it.instance("page hydration matches get for each message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const paged = yield* MessageV2.page({ sessionID, limit: 10 })
        for (const item of paged.items) {
          const got = yield* MessageV2.get({ sessionID, messageID: item.info.id as MessageID })
          expect(got.info).toEqual(item.info)
          expect(got.parts).toEqual(item.parts)
        }
      }),
    ),
  )

  it.instance("parts from get match standalone parts call", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const got = yield* MessageV2.get({ sessionID, messageID: id })
        const standalone = yield* MessageV2.parts(id)
        expect(got.parts).toEqual(standalone)
      }),
    ),
  )

  it.instance("stream collects same messages as exhaustive page iteration", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 7)

        const streamed = yield* MessageV2.stream(sessionID)

        const paged = [] as SessionV1.WithParts[]
        let cursor: string | undefined
        while (true) {
          const result = yield* MessageV2.page({ sessionID, limit: 3, before: cursor })
          for (let i = result.items.length - 1; i >= 0; i--) {
            paged.push(result.items[i])
          }
          if (!result.more || !result.cursor) break
          cursor = result.cursor
        }

        expect(streamed.map((m) => m.info.id)).toEqual(paged.map((m) => m.info.id))
      }),
    ),
  )

  it.instance("filterCompacted of full stream returns same as Array.from when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 4)

        const stream = yield* MessageV2.stream(sessionID)
        const filtered = MessageV2.filterCompacted(stream)
        const all = stream.toReversed()

        expect(filtered.map((m) => m.info.id)).toEqual(all.map((m) => m.info.id))
      }),
    ),
  )
})
