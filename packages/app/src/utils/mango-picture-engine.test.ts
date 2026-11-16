import { describe, expect, test } from "bun:test"
import { createPictureEngine } from "./mango-picture-engine"

/**
 * A clock that runs only when told: the timers of the engine are kept with the time they are due. `owed` is what the
 * page keeps across a reload; a page started again is another `setup` with the same one. `read` is whether the page has
 * already read the app's state and the models that draw (before that it cannot say whether pictures are on view).
 */
function setup(unload: () => Promise<void> = async () => undefined, owed = { value: false }, read = true) {
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
    owed: { read: () => owed.value, write: (value) => void (owed.value = value) },
  })
  if (read) engine.firstRead()
  const advance = async (ms: number) => {
    now += ms
    for (const timer of timers.filter((t) => t.live && t.at <= now)) {
      timer.live = false
      timer.run()
      await Bun.sleep(0)
    }
  }
  return { engine, calls, advance, owed }
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

  test("a page started again within the grace after the pictures were left still puts the engine away", async () => {
    const first = setup()
    first.engine.enter()()
    // the page is gone before its timer runs; the one that takes its place finds what was left to do
    const second = setup(undefined, first.owed)
    await second.advance(1000)
    expect(second.calls).toEqual(["unload"])
    expect(second.owed.value).toBe(false)
    await second.advance(60_000)
    expect(second.calls).toEqual(["unload"])
  })
  test("a page started again with the pictures still on view puts the engine away only if they are not on view again", async () => {
    const first = setup()
    first.engine.enter()
    const back = setup(undefined, first.owed)
    back.engine.enter()
    await back.advance(5000)
    expect(back.calls).toEqual([])
    const gone = setup(undefined, first.owed)
    await gone.advance(1000)
    expect(gone.calls).toEqual(["unload"])
  })
  test("a page that never showed pictures leaves an engine another program started alone", async () => {
    const { calls, advance } = setup()
    await advance(60_000)
    expect(calls).toEqual([])
  })
  test("an engine that could not be put away is still owed to the next page", async () => {
    const first = setup(async () => {
      throw new Error("no answer")
    })
    first.engine.enter()()
    await first.advance(1000)
    expect(first.owed.value).toBe(true)
    const second = setup(undefined, first.owed)
    await second.advance(1000)
    expect(second.calls).toEqual(["unload"])
    expect(second.owed.value).toBe(false)
  })

  test("a page started again waits to have read the app before it counts: pictures on view by then keep the engine", async () => {
    const left = setup()
    left.engine.enter()
    const slow = setup(undefined, left.owed, false)
    // a busy computer: the state, the models and the messages take longer than the grace
    await slow.advance(60_000)
    expect(slow.calls).toEqual([])
    const composer = slow.engine.undecided()
    slow.engine.firstRead()
    await slow.advance(60_000)
    expect(slow.calls).toEqual([])
    slow.engine.enter()
    composer()
    await slow.advance(60_000)
    expect(slow.calls).toEqual([])
  })
  test("a page started again counts from the moment it has read the app and its box says pictures are not on view", async () => {
    const left = setup()
    left.engine.enter()()
    const slow = setup(undefined, left.owed, false)
    const composer = slow.engine.undecided()
    slow.engine.firstRead()
    await slow.advance(60_000)
    expect(slow.calls).toEqual([])
    composer()
    await slow.advance(900)
    expect(slow.calls).toEqual([])
    await slow.advance(100)
    expect(slow.calls).toEqual(["unload"])
  })
  test("a box that goes away without having said keeps nothing waiting", async () => {
    const left = setup()
    left.engine.enter()()
    const again = setup(undefined, left.owed)
    const composer = again.engine.undecided()
    composer()
    composer()
    await again.advance(1000)
    expect(again.calls).toEqual(["unload"])
  })
  test("the answer to a put-away that began before the pictures came back does not forget the next one", async () => {
    let answer = () => {}
    const first = setup(() => new Promise<void>((resolve) => void (answer = resolve)))
    first.engine.enter()()
    await first.advance(1000)
    expect(first.calls).toEqual(["unload"])
    // the pictures come back and are left again while the first request has not been answered
    first.engine.enter()()
    answer()
    await Bun.sleep(0)
    expect(first.owed.value).toBe(true)
    await first.advance(1000)
    expect(first.calls).toEqual(["unload", "unload"])
  })
  test("the answer to a put-away is the end of it when nothing happened meanwhile", async () => {
    const { engine, owed, advance } = setup()
    engine.enter()()
    await advance(1000)
    expect(owed.value).toBe(false)
  })
})
