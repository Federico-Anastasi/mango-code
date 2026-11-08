export const normalizeModelSearch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ")

export const compactModelSearch = (value: string) => normalizeModelSearch(value).replaceAll(" ", "")

const localProvider = "mango"

/** Local models keep the order in which the configuration lists them and come first; the others go by name. */
export const compareModels = (a: { provider: { id: string }; name: string }, b: { provider: { id: string }; name: string }) => {
  const aLocal = a.provider.id === localProvider
  if (aLocal !== (b.provider.id === localProvider)) return aLocal ? -1 : 1
  return aLocal ? 0 : a.name.localeCompare(b.name)
}

export const matchesModelSearch = (query: string, values: string[]) => {
  const search = normalizeModelSearch(query)
  if (!search) return true

  const compactSearch = compactModelSearch(query)
  return values.some(
    (value) => normalizeModelSearch(value).includes(search) || compactModelSearch(value).includes(compactSearch),
  )
}
