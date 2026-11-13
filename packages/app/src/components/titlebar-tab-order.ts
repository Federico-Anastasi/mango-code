export function mergeVisibleTabOrder(all: string[], current: string[], next: string[]) {
  const visible = new Set(current)
  const reordered = next.values()
  return all.map((key) => (visible.has(key) ? (reordered.next().value ?? key) : key))
}
