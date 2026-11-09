import type { HomeSessionGroup } from "./home-sessions-controller"

/** The conversations of the Home that match what was typed (in the title or the project name), without the groups left empty. */
export function filterHomeGroups(groups: HomeSessionGroup[], query: string, title: (title: string) => string) {
  const text = query.trim().toLowerCase()
  if (!text) return groups
  return groups
    .map((group) => ({
      ...group,
      sessions: group.sessions.filter((record) =>
        `${title(record.session.title)} ${record.projectName}`.toLowerCase().includes(text),
      ),
    }))
    .filter((group) => group.sessions.length > 0)
}
