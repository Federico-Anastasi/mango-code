const pattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

interface Info {
  readonly title?: string
  readonly parentID?: string
  readonly time: {
    readonly created: number
  }
}

export function withTimestampedFallback(info: Info) {
  return info.title ?? `${info.parentID ? "Child" : "New"} session - ${new Date(info.time.created).toISOString()}`
}

/** Title to show: the provisional English titles with a timestamp become `untitled` (if given). */
export function sessionTitle(title?: string, untitled?: string) {
  if (!title) return title
  const match = title.match(pattern)
  if (!match) return title
  return untitled ?? match[1]
}
