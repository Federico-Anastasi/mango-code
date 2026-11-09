import { pathKey } from "@/utils/path-key"

type ServerProject = { worktree: string; time: { updated: number } }

/**
 * The folders to add to this browser's project list: those the agent knows (it keeps every project ever opened, from the
 * computer or from another browser) and this browser does not have, except the ones the user closed here. Oldest first,
 * because opening a project puts it on top: the most recent ends up first. The `/` of the global pseudo-project is not
 * a folder.
 */
export function projectsToOpen(known: ServerProject[], listed: string[], closed: string[]) {
  const skip = new Set([...listed, ...closed].map(pathKey))
  return known
    .filter((project) => project.worktree !== "/" && !skip.has(pathKey(project.worktree)))
    .toSorted((a, b) => a.time.updated - b.time.updated)
    .map((project) => project.worktree)
}
