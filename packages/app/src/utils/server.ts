import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

/** The headers of a request to a server with its password, if it has one. */
export function authHeaders(http: { username?: string; password?: string }): Record<string, string> {
  if (!http.password) return {}
  return { authorization: `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}` }
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: input.server.username,
            password: input.server.password,
          })}`,
        }
      : undefined,
  })
}

export type ServerApi = OpenCodeClient

/**
 * The default server saved by the user, if it is still to be used. In the Mango Code window an address on this computer is
 * the agent of some earlier run, on a port that may be taken by now: the page is served by the agent it is open on, so that
 * one is used. A normal browser keeps the user's choice, a server on their own computer included.
 */
export function defaultServerToUse(stored: string | null, inDesktopWindow: boolean) {
  if (!stored) return null
  return inDesktopWindow && isLocalServerUrl(stored) ? null : stored
}

/** An address on this computer: the agent of Mango Code lives at one, and its port is not always the same. */
export function isLocalServerUrl(url: string) {
  if (!URL.canParse(url)) return false
  const host = new URL(url).hostname
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]"
}
