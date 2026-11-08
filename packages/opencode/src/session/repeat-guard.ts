// mango-code: the same wrong call, repeated. A local model sometimes calls the same tool again with the same input
// that has just failed, even when its reasoning says what the mistake was: every round costs a generation and makes
// the conversation longer. Here, for each conversation, the last failed call is remembered: an identical call (same
// tool, same input) is not run again and the model receives the previous error with a request to change the input.
// Any successful call in between erases the memory, because the world may have changed (a file created, a server
// restarted). It applies to every tool.

type Failure = { key: string; error: string }

const lastFailure = new Map<string, Failure>()

/** Stable key of a call: the name and the input with its keys in order. */
function callKey(tool: string, args: unknown) {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((value as Record<string, unknown>)[k])]),
      )
    return value
  }
  return `${tool}\u0000${JSON.stringify(sort(args ?? {}))}`
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Wraps the `execute` of a tool for a conversation. */
export function guardExecute<A, O, R>(
  sessionID: string,
  tool: string,
  execute: (args: A, opts: O) => Promise<R>,
): (args: A, opts: O & { abortSignal?: AbortSignal }) => Promise<R> {
  return async (args, opts) => {
    const key = callKey(tool, args)
    const failed = lastFailure.get(sessionID)
    if (failed?.key === key)
      throw new Error(
        `This is the same call (same tool, same input) that has just failed with this error: ${failed.error}\n` +
          "I am not running it again: change the input according to the error, then retry.",
      )
    try {
      const result = await execute(args, opts)
      lastFailure.delete(sessionID)
      return result
    } catch (error) {
      // Stopped by the user: not an error of the tool.
      if (!opts.abortSignal?.aborted) lastFailure.set(sessionID, { key, error: message(error) })
      throw error
    }
  }
}

/** Only for tests. */
export function resetRepeatGuard() {
  lastFailure.clear()
}
