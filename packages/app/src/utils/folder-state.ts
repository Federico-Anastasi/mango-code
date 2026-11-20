import { folderKey } from "./path-key"

/**
 * What a per-folder record holds under another spelling of a folder that stays (`kept`) is moved to the spelling that
 * stays (`name` gives the key that spelling has in this record); an entry already under that key wins. `undefined` when
 * nothing needs to move.
 */
export function moveToKept<T>(
  record: Record<string, T>,
  kept: readonly string[],
  name: (path: string) => string = (path) => path,
) {
  const target = new Map(kept.map((path) => [folderKey(path), name(path)]))
  const stays = (key: string) => (target.get(folderKey(key)) ?? key) === key
  const entries = Object.entries(record)
  if (entries.every(([key]) => stays(key))) return
  const next = Object.fromEntries(entries.filter(([key]) => stays(key)))
  for (const [key, value] of entries) {
    const to = target.get(folderKey(key))
    if (to !== undefined && !(to in next)) next[to] = value
  }
  return next
}
