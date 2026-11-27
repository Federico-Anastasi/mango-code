import { describe, expect, test } from "bun:test"
import { serverPrice } from "./mango-server-price"

describe("the price of a server's model, as the user reads it", () => {
  test("dollars per million tokens read and written, with the digits that matter; free; nothing when not said", () => {
    expect(serverPrice({ input: 0.3, output: 1.2 }, "it-IT")).toEqual({ kind: "paid", input: "0,30", output: "1,20" })
    expect(serverPrice({ input: 15, output: 75 }, "en-US")).toEqual({ kind: "paid", input: "15.00", output: "75.00" })
    expect(serverPrice({ input: 0.0375, output: 0.15 }, "en-US")).toEqual({ kind: "paid", input: "0.0375", output: "0.15" })
    expect(serverPrice({ input: 0, output: 0 }, "en-US")).toEqual({ kind: "free" })
    expect(serverPrice(undefined, "en-US")).toBeUndefined()
  })
})
