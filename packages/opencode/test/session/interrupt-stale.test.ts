import { afterEach, describe, expect, spyOn } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      InstanceStore.node,
      Session.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
    ]),
    [[InstanceStore.bootstrapNode, InstanceBootstrap.node]],
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const BEFORE_THIS_PROCESS = 1_000

type Draft =
  | { type: "tool"; tool: string; state: SessionV1.ToolPart["state"] }
  | { type: "text" | "reasoning"; text: string }

const turn = (sessionID: SessionID, at: number, drafts: Draft[]) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const assistant: SessionV1.Assistant = {
      id: MessageID.ascending(),
      sessionID,
      parentID: MessageID.ascending(),
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/", root: "/" },
      time: { created: at },
      role: "assistant",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "none" as SessionV1.Assistant["modelID"],
      providerID: "none" as SessionV1.Assistant["providerID"],
    }
    yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistant })
    const parts = drafts.map((draft, index): SessionV1.Part => {
      const base = { id: PartID.ascending(), messageID: assistant.id, sessionID }
      return draft.type === "tool"
        ? { ...base, type: "tool", tool: draft.tool, callID: `call_${index}`, state: draft.state }
        : { ...base, type: draft.type, text: draft.text, time: { start: at } }
    })
    yield* Effect.forEach(parts, (part) => events.publish(SessionV1.Event.PartUpdated, { sessionID, part, time: at }))
    return { assistant, parts }
  })

const running = (
  input: Record<string, unknown>,
  at: number,
  metadata?: Record<string, unknown>,
): SessionV1.ToolPart["state"] => ({
  status: "running",
  time: { start: at },
  input,
  metadata,
})

describe("session.interruptStale", () => {
  it.live("a restart leaves the conversation as an interrupted turn would, and spares what this process runs", () =>
    Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const directory = yield* tmpdirScoped({ git: true })

      const ids = yield* store.provide(
        { directory },
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const session = yield* sessions.create()
          const at = BEFORE_THIS_PROCESS
          const picture = yield* turn(session.id, at, [
            {
              type: "tool",
              tool: "image_generate",
              state: running({ request: "a cat" }, at, { stage: "drawing", step: 3 }),
            },
          ])
          const command = yield* turn(session.id, at, [
            { type: "tool", tool: "bash", state: running({ command: "sleep 60" }, at, { output: "partial" }) },
          ])
          const waiting = yield* turn(session.id, at, [
            { type: "tool", tool: "read", state: { status: "pending", input: {}, raw: "" } },
          ])
          const writing = yield* turn(session.id, at, [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "I was writing" },
          ])
          const now = Date.now()
          const live = yield* turn(session.id, now, [
            { type: "tool", tool: "bash", state: running({ command: "sleep 60" }, now) },
            { type: "text", text: "still writing" },
          ])
          return { session: session.id, picture, command, waiting, writing, live }
        }),
      )

      const read = (sessionID: SessionID) =>
        store.provide(
          { directory },
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            return yield* sessions.messages({ sessionID })
          }),
        )
      const part = (messages: SessionV1.WithParts[], id: PartID) =>
        messages.flatMap((message) => message.parts).find((candidate) => candidate.id === id)
      const info = (messages: SessionV1.WithParts[], id: MessageID) =>
        messages.find((message) => message.info.id === id)?.info as SessionV1.Assistant

      yield* store.disposeDirectory(directory)
      const messages = yield* read(ids.session)

      const closedError = (id: MessageID) => {
        const message = info(messages, id)
        expect(message.time.completed).toBeNumber()
        expect(message.error?.name).toBe("MessageAbortedError")
      }

      const picture = part(messages, ids.picture.parts[0].id) as SessionV1.ToolPart
      expect(picture.state.status).toBe("error")
      if (picture.state.status === "error") {
        expect(picture.state.error).toBe("Tool execution aborted")
        expect(picture.state.metadata).toMatchObject({ stage: "drawing", step: 3, interrupted: true })
        expect(picture.state.time.start).toBe(BEFORE_THIS_PROCESS)
      }
      closedError(ids.picture.assistant.id)

      const command = part(messages, ids.command.parts[0].id) as SessionV1.ToolPart
      expect(command.state.status).toBe("error")
      if (command.state.status === "error")
        expect(command.state.metadata).toMatchObject({ output: "partial", interrupted: true })
      closedError(ids.command.assistant.id)

      const waiting = part(messages, ids.waiting.parts[0].id) as SessionV1.ToolPart
      expect(waiting.state.status).toBe("error")
      if (waiting.state.status === "error") expect(waiting.state.metadata).toMatchObject({ interrupted: true })
      closedError(ids.waiting.assistant.id)

      const writing = ids.writing.parts.map((written) => part(messages, written.id))
      expect(
        writing.map((candidate) =>
          candidate?.type === "text" || candidate?.type === "reasoning" ? candidate.text : undefined,
        ),
      ).toEqual(["thinking", "I was writing"])
      writing.forEach((candidate) => {
        if (candidate?.type !== "text" && candidate?.type !== "reasoning") throw new Error("expected text or reasoning")
        expect(candidate.time?.end).toBeNumber()
      })
      closedError(ids.writing.assistant.id)

      // The model is told what the command had printed before the restart.
      const model = yield* Effect.promise(() =>
        MessageV2.toModelMessages(
          messages.filter((message) => message.info.id === ids.command.assistant.id),
          ProviderTest.model(),
        ),
      )
      expect(JSON.stringify(model)).toContain("partial")
      expect(JSON.stringify(model)).not.toContain("Tool execution aborted")

      const closedAt = info(messages, ids.command.assistant.id).time.completed

      // Opening the folder again, even after the system clock jumped forward, changes nothing that is already closed
      // and still spares what this process runs.
      const realNow = Date.now.bind(Date)
      const clock = spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000)
      yield* store.disposeDirectory(directory)
      const again = yield* read(ids.session).pipe(Effect.ensuring(Effect.sync(() => clock.mockRestore())))
      expect(info(again, ids.command.assistant.id).time.completed).toBe(closedAt)
      ;[messages, again].forEach((seen) => {
        const live = part(seen, ids.live.parts[0].id) as SessionV1.ToolPart
        expect(live.state.status).toBe("running")
        const text = part(seen, ids.live.parts[1].id)
        expect(text?.type === "text" ? text.time?.end : "not text").toBeUndefined()
        expect(info(seen, ids.live.assistant.id).time.completed).toBeUndefined()
        expect(info(seen, ids.live.assistant.id).error).toBeUndefined()
      })
    }),
  )
})
