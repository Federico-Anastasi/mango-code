import { describe, expect, test } from "bun:test"
import { createPictureEngine } from "./mango-picture-engine"

/** A clock that runs only when told: the timers of the engine are kept with the time they are due. */
function setup(unload: () => Promise<void> = async () => undefined) {
  const calls: string[] = []
  const timers: { at: number; run: () => void; live: boolean }[] = []
  let now = 0
  const engine = createPictureEngine({
    unload: () => (calls.push("unload"), unload()),
    later: (ms, run) => {
      const timer = { at: now + ms, run, live: true }
      timers.push(timer)
      return () => void (timer.live = false)
    },
    grace: 1000,
  })
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.live && t.at <= now)) {
      timer.live = false
      timer.run()
      await Bun.sleep(0)
    }
  }
  return { engine, calls, advance }
}

describe("the engine that draws, put away when the user leaves pictures", () => {
  test("the app is asked once, after the grace, when the last view of pictures goes", async () => {
    const { engine, calls, advance } = setup()
    const leave = engine.enter()
    await advance(5000)
    expect(calls).toEqual([])
    leave()
    await advance(500)
    expect(calls).toEqual([])
    await advance(600)
    expect(calls).toEqual(["unload"])
    await advance(60_000)
    expect(calls).toEqual(["unload"])
  })
  test("leaving twice with the same hand counts once", async () => {
    const { engine, calls, advance } = setup()
    const first = engine.enter()
    const second = engine.enter()
    first()
    first()
    await advance(5000)
    expect(calls).toEqual([])
    second()
    await advance(1000)
    expect(calls).toEqual(["unload"])
  })
  test("going from one picture conversation to another does not put it away", async () => {
    const { engine, calls, advance } = setup()
    const leave = engine.enter()
    leave()
    await advance(300)
    engine.enter()
    await advance(10_000)
    expect(calls).toEqual([])
  })
  test("a view that came and went again starts the grace again", async () => {
    const { engine, calls, advance } = setup()
    engine.enter()()
    await advance(700)
    engine.enter()()
    await advance(700)
    expect(calls).toEqual([])
    await advance(300)
    expect(calls).toEqual(["unload"])
  })
  test("an app that does not answer is not asked again, and the next leave asks as usual", async () => {
    const { engine, calls, advance } = setup(async () => {
      throw new Error("no answer")
    })
    engine.enter()()
    await advance(1000)
    await advance(60_000)
    expect(calls).toEqual(["unload"])
    engine.enter()()
    await advance(1000)
    expect(calls).toEqual(["unload", "unload"])
  })
})
