import type { ServerConnection } from "@/context/server"
import { authHeaders } from "@/utils/server"

// mango-code: what the agent answers about a folder before it becomes a project (see the agent's
// shared/mango-project-folder.ts): is it too broad (Desktop, Documents, the user's folder, a disk...), and make a subfolder.

async function call(http: ServerConnection.HttpBase, path: string, init?: RequestInit) {
  const headers = { "Content-Type": "application/json", ...authHeaders(http) }
  const response = await fetch(new URL(path, http.url), { ...init, headers })
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `${response.status}`)
  return body ?? {}
}

export async function folderIsBroad(http: ServerConnection.HttpBase, directory: string) {
  return (await call(http, `/mango/folder?directory=${encodeURIComponent(directory)}`)).broad === true
}

/** Creates `<parent>\<name>` and returns its path; the error carries the agent's sentence, in the user's language. */
export async function createSubfolder(http: ServerConnection.HttpBase, parent: string, name: string) {
  const created = await call(http, "/mango/folder", { method: "POST", body: JSON.stringify({ parent, name }) })
  if (typeof created.directory !== "string") throw new Error("the agent did not return the new folder")
  return created.directory
}
