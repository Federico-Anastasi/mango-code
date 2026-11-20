import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, defaultServerToUse, isLocalServerUrl } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("isLocalServerUrl", () => {
  test("an address on this computer, whatever its port", () => {
    for (const url of ["http://127.0.0.1:4096", "http://127.0.0.1:50321/", "http://localhost:4096", "https://localhost", "http://[::1]:4096"])
      expect(isLocalServerUrl(url)).toBe(true)
  })

  test("any other address, and what is not an address, is not", () => {
    for (const url of ["http://192.168.1.5:4096", "https://example.com", "http://127.0.0.1.example.com:4096", "", "127.0.0.1:4096"])
      expect(isLocalServerUrl(url)).toBe(false)
  })
})

describe("defaultServerToUse", () => {
  test("in the Mango Code window an address on this computer is the agent of an earlier run and is not used", () => {
    expect(defaultServerToUse("http://127.0.0.1:4096", true)).toBeNull()
    expect(defaultServerToUse("http://localhost:50321", true)).toBeNull()
  })

  test("in a normal browser a server on this computer is the user's choice and stays", () => {
    expect(defaultServerToUse("http://127.0.0.1:4096", false)).toBe("http://127.0.0.1:4096")
    expect(defaultServerToUse("http://localhost:4096", false)).toBe("http://localhost:4096")
  })

  test("another address stays everywhere, and nothing stored is nothing", () => {
    expect(defaultServerToUse("https://example.com", true)).toBe("https://example.com")
    expect(defaultServerToUse(null, true)).toBeNull()
    expect(defaultServerToUse("", false)).toBeNull()
  })
})
