import { describe, expect, test } from "bun:test"
import { guardExecute, resetRepeatGuard } from "@/session/repeat-guard"

const succeeds = async () => "done"
const opts = (aborted = false) => ({ abortSignal: { aborted } as AbortSignal })

describe("the same wrong call, repeated", () => {
  test("the second call identical to a failed one is not run and gives the previous error", async () => {
    resetRepeatGuard()
    let runs = 0
    const exec = guardExecute("ses_a", "video_plan_write", async () => {
      runs++
      throw new Error("frame: expected text, received object")
    })
    await expect(exec({ frame: { x: 1 }, n: 2 }, opts())).rejects.toThrow("frame: expected text")
    const err = await exec({ n: 2, frame: { x: 1 } }, opts()).catch((e) => e as Error) // same keys, other order
    expect(runs).toBe(1)
    expect(err.message).toContain("same call")
    expect(err.message).toContain("frame: expected text, received object")
    expect(err.message).toContain("change the input")
  })

  test("with a different input the call runs", async () => {
    resetRepeatGuard()
    let runs = 0
    const exec = guardExecute("ses_a", "read", async (args: any) => {
      runs++
      if (args.file === "x") throw new Error("not found")
      return "ok"
    })
    await exec({ file: "x" }, opts()).catch(() => {})
    expect(await exec({ file: "y" }, opts())).toBe("ok")
    expect(runs).toBe(2)
  })

  test("after a successful call (even of another tool) the same call is tried again", async () => {
    resetRepeatGuard()
    let runs = 0
    const a = guardExecute("ses_a", "read", async () => {
      runs++
      throw new Error("not found")
    })
    const b = guardExecute("ses_a", "write", succeeds)
    await a({ file: "x" }, opts()).catch(() => {})
    await b({ file: "x" }, opts())
    await a({ file: "x" }, opts()).catch(() => {})
    expect(runs).toBe(2)
  })

  test("each conversation has its own memory, and a call stopped by the user does not count as an error", async () => {
    resetRepeatGuard()
    let runs = 0
    const exec = (s: string) =>
      guardExecute(s, "read", async () => {
        runs++
        throw new Error("error")
      })
    await exec("ses_a")({ file: "x" }, opts()).catch(() => {})
    await exec("ses_b")({ file: "x" }, opts()).catch(() => {})
    expect(runs).toBe(2)
    await exec("ses_c")({ file: "x" }, opts(true)).catch(() => {})
    await exec("ses_c")({ file: "x" }, opts()).catch(() => {})
    expect(runs).toBe(4)
  })
})
