import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createRunningPrograms, type RunningProgram } from "@/pages/session/running-programs"

const program: RunningProgram = {
  pid: 4321,
  started: 1_700_000_000_000,
  name: "bun.exe",
  command: "bun.exe index.html",
  asked: "Start-Process bun",
}

describe("the list of the programs left running, in the side panel", () => {
  const cleanup: (() => void)[] = []
  const visibility = (value: string) =>
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value })
  afterEach(() => {
    cleanup.splice(0).forEach((done) => done())
    visibility("visible")
  })

  /** The list of a conversation, with an agent that answers what `answer` says and remembers what it was asked. */
  function mount(answer: (path: string, init?: RequestInit) => Response | Promise<Response>) {
    const asked: { path: string; init?: RequestInit }[] = []
    const [status, setStatus] = createSignal<string | undefined>("idle")
    const list = createRoot((dispose) => {
      cleanup.push(dispose)
      return createRunningPrograms({
        sessionID: "ses_a",
        status,
        request: async (path, init) => {
          asked.push({ path, init })
          return answer(path, init)
        },
      })
    })
    return { list, asked, setStatus }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const pids = (page: ReturnType<typeof mount>) => page.list.state.programs.map((item) => item.pid)

  test("reads the programs of its conversation, and again when the conversation changes state", async () => {
    const list = { programs: [program] }
    const page = mount(() => Response.json({ processes: list.programs }))
    await settle()
    expect(page.list.state.programs).toEqual([program])
    expect(page.asked[0].path).toBe("/mango/processes?sessionID=ses_a")
    list.programs = []
    page.setStatus("busy")
    await settle()
    expect(pids(page)).toEqual([])
  })

  test("a reading that fails keeps the list as it was", async () => {
    const replies = [Response.json({ processes: [program] }), Response.json({ error: "unreadable" }, { status: 500 })]
    const page = mount(() => replies.shift() ?? Promise.reject(new Error("offline")))
    await settle()
    expect(pids(page)).toEqual([4321])
    page.setStatus("busy")
    await settle()
    expect(pids(page)).toEqual([4321])
    page.setStatus("idle")
    await settle()
    expect(page.asked.length).toBe(3)
    expect(pids(page)).toEqual([4321])
  })

  test("an agent that refuses the list (the phone) is not asked again", async () => {
    const page = mount(() => Response.json({ error: "PC only" }, { status: 403 }))
    await settle()
    page.setStatus("busy")
    await settle()
    expect(page.asked.length).toBe(1)
  })

  test("a hidden page does not ask, and asks when it is seen again", async () => {
    visibility("hidden")
    const page = mount(() => Response.json({ processes: [program] }))
    await settle()
    page.setStatus("busy")
    await settle()
    expect(page.asked.length).toBe(0)
    visibility("visible")
    document.dispatchEvent(new Event("visibilitychange"))
    await settle()
    expect(pids(page)).toEqual([4321])
  })

  test("Stop sends the program's number and creation time, then reads the list again", async () => {
    const list = { programs: [program] }
    const page = mount((path) => {
      if (!path.endsWith("/stop")) return Response.json({ processes: list.programs })
      list.programs = []
      return Response.json({ stopped: true })
    })
    await settle()
    expect(await page.list.stop(program)).toBe(true)
    const stop = page.asked.find((item) => item.path === "/mango/processes/stop")
    expect(stop?.init?.method).toBe("POST")
    expect(JSON.parse(String(stop?.init?.body))).toEqual({ sessionID: "ses_a", pid: 4321, started: program.started })
    expect(pids(page)).toEqual([])
  })

  test("Stop says when the program did not stop; one that had already ended is not a failure", async () => {
    const stops = [
      Response.json({ error: "the program did not stop" }, { status: 500 }),
      Response.json({ error: "gone" }, { status: 404 }),
    ]
    const page = mount((path) => (path.endsWith("/stop") ? stops.shift()! : Response.json({ processes: [program] })))
    await settle()
    expect(await page.list.stop(program)).toBe(false)
    expect(await page.list.stop(program)).toBe(true)
  })
})
