export type PathKey = string & { _brand: "PathKey" }

const drivePath = /^[A-Za-z]:(?:[\\/]|$)/
const longForm = /^[\\/]{2}\?[\\/](?:UNC[\\/])?/i

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => drivePath.test(value) || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (drivePath.test(trimmed) && trimmed.length === 2) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}

/** `\\?\C:\x` is `C:\x` and `\\?\UNC\server\share` is `\\server\share`. */
const withoutLongForm = (path: string) => {
  const prefix = longForm.exec(path)?.[0]
  if (!prefix) return path
  return /unc/i.test(prefix) ? `\\\\${path.slice(prefix.length)}` : path.slice(prefix.length)
}

/**
 * The key that says whether two paths are the same project folder: `pathKey` and, for a path on a drive, the letter
 * case, which Windows does not tell apart. A network path (`\\server\share`, `\\wsl$\Ubuntu`) keeps its case, because
 * what is behind it may tell it apart. Only to compare: it is not a path to open, and the paths themselves keep the
 * spelling they were given.
 */
export const folderKey = (path: string) => {
  const plain = withoutLongForm(path)
  const key = pathKey(plain)
  return (drivePath.test(plain) ? key.toLowerCase() : key) as PathKey
}
