import { expect, test } from "bun:test"
import { teamIsOn } from "./team-switch"

test("the Team button is in the chat only when the key is saved and the agent has the Team", () => {
  expect(teamIsOn({ key: true }, ["build", "team"])).toBe(true)
  // no key: the Team is configured in the settings, not from the chat
  expect(teamIsOn({ key: false }, ["build"])).toBe(false)
  // key saved but the agent has not restarted with the Team yet
  expect(teamIsOn({ key: true }, ["build"])).toBe(false)
  // not in the app (phone, browser) or the info is not there yet
  expect(teamIsOn(undefined, ["build", "team"])).toBe(false)
})
