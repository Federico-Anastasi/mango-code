// A project folder deleted or moved from the disk: the server answers 404 "Directory not found: <path>".
// Every place of the app that showed that error in an English toast now reports it here; a single listener
// (layout-new) removes the project from the list and says once, in the user's language, what happened.

const message = /Directory not found: (.+?)\s*$/

type Listener = (directory: string) => void
const listeners = new Set<Listener>()

export function missingDirectoryIn(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    const match = text?.match(message)
    if (match) return match[1]
  }
}

export function onMissingDirectory(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function reportMissingDirectory(directory: string) {
  listeners.forEach((listener) => listener(directory))
}

/** True if the call failed because the folder does not exist (the client call throws with status and body in `cause`). */
export function isDirectoryMissingError(err: unknown) {
  const cause = (err as { cause?: { status?: number; body?: { name?: string } } } | undefined)?.cause
  return cause?.status === 404 && cause.body?.name === "DirectoryNotFound"
}
