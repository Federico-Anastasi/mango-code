import { afterEach, describe, expect, test } from "bun:test"
import { describeQueue } from "@/server/shared/engine-speed"
import { engineQueue, enqueueEngineRequest, resetEngineQueue } from "@/provider/engine-queue"

afterEach(resetEngineQueue)

describe("engine queue", () => {
  test("with no requests nobody is active and nobody waits", () => {
    expect(engineQueue()).toEqual({ waiting: [] })
  })

  test("the oldest request is active, the others wait in order of arrival", () => {
    enqueueEngineRequest("calculator", { now: 1 })
    enqueueEngineRequest("hello", { now: 2 })
    enqueueEngineRequest("third", { now: 3 })
    const queue = engineQueue()
    expect(queue.active?.sessionID).toBe("calculator")
    expect(queue.waiting.map((item) => item.sessionID)).toEqual(["hello", "third"])
  })

  test("when the active request ends the turn passes to the next", () => {
    const first = enqueueEngineRequest("calculator", { now: 1 })
    enqueueEngineRequest("hello", { now: 2 })
    first()
    expect(engineQueue()).toEqual({
      active: { sessionID: "hello", requestSessionID: "hello", since: 2 },
      waiting: [],
    })
  })

  test("a request that leaves the queue (cancelled) does not block the others; releasing twice is harmless", () => {
    enqueueEngineRequest("a", { now: 1 })
    const b = enqueueEngineRequest("b", { now: 2 })
    enqueueEngineRequest("c", { now: 3 })
    b()
    b()
    expect(engineQueue().waiting.map((item) => item.sessionID)).toEqual(["c"])
  })

  test("a conversation with two requests at once (answer and title) appears only once", () => {
    enqueueEngineRequest("a", { now: 1 })
    enqueueEngineRequest("a", { now: 2 })
    enqueueEngineRequest("b", { now: 3 })
    enqueueEngineRequest("b", { now: 4 })
    const queue = engineQueue()
    expect(queue.active?.sessionID).toBe("a")
    expect(queue.waiting.map((item) => item.sessionID)).toEqual(["b"])
  })

  test("a sub-agent counts for the conversation it started from", () => {
    enqueueEngineRequest("child", { parentSessionID: "parent", now: 1 })
    enqueueEngineRequest("parent", { now: 2 })
    const queue = engineQueue()
    expect(queue.active).toEqual({ sessionID: "parent", requestSessionID: "child", since: 1 })
    expect(queue.waiting).toEqual([])
  })
})

describe("route response", () => {
  test("includes title and folder; the default title is not a name and is not shown", () => {
    enqueueEngineRequest("calc", { now: 1 })
    enqueueEngineRequest("hello", { now: 2 })
    const info = new Map([
      ["calc", { title: "Calculator in index.html", directory: "C:/p" }],
      ["hello", { title: "New session - 2026-10-30T10:00:00.000Z", directory: "C:/p" }],
    ])
    expect(describeQueue(engineQueue(), info)).toEqual({
      active: { sessionID: "calc", requestSessionID: "calc", title: "Calculator in index.html", directory: "C:/p", since: 1 },
      waiting: [{ sessionID: "hello", requestSessionID: "hello", directory: "C:/p", since: 2 }],
    })
  })

  test("with no requests: no active one (null) and an empty queue", () => {
    expect(describeQueue(engineQueue(), new Map())).toEqual({ active: null, waiting: [] })
  })

  test("session not found in the database: the id stays, without a title", () => {
    enqueueEngineRequest("vanished", { now: 5 })
    expect(describeQueue(engineQueue(), new Map()).active).toEqual({
      sessionID: "vanished",
      requestSessionID: "vanished",
      since: 5,
    })
  })
})
