import { createSignal } from "solid-js"
import {
  PROJECT_FRUITS,
  PROJECT_FRUIT_PREFIX,
  isProjectFruit,
  type ProjectFruit,
} from "@opencode-ai/ui/v2/project-fruits"
import { pathKey } from "@/utils/path-key"

export type FruitProject = {
  id?: string
  worktree: string
  icon?: { color?: string }
  time?: { created?: number }
}

/** The fruit chosen by the user: stored in the project's color field as "fruit:pear". Old colors do not count. */
export function storedFruit(color?: string): ProjectFruit | undefined {
  if (!color?.startsWith(PROJECT_FRUIT_PREFIX)) return undefined
  const value = color.slice(PROJECT_FRUIT_PREFIX.length)
  return isProjectFruit(value) ? value : undefined
}

export const fruitColor = (fruit: ProjectFruit) => `${PROJECT_FRUIT_PREFIX}${fruit}`

/** Stable key of the project: the id (the same for all working copies of the same repo), for projects without a git id the path. */
export function projectFruitSeed(project: { id?: string; worktree: string }) {
  return project.id && project.id !== "global" ? project.id : pathKey(project.worktree)
}

// 32-bit FNV-1a: fast and well mixed even on ids that differ by a few digits.
function hash(value: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const hashed = (seed: string) => PROJECT_FRUITS[hash(seed) % PROJECT_FRUITS.length]

/**
 * Assigns a fruit to every project. The user's choices stay as they are; the others start from the fruit of their
 * hash and move on to the first free one, in creation order: a new project does not change the fruit of the existing ones,
 * and as long as there are at most 16 projects no fruit repeats.
 */
export function assignProjectFruits(projects: readonly FruitProject[]) {
  const result = new Map<string, ProjectFruit>()
  const chosen = new Set<ProjectFruit>()
  const automatic: Array<{ seed: string; created: number }> = []
  for (const project of projects) {
    const seed = projectFruitSeed(project)
    const explicit = storedFruit(project.icon?.color)
    if (explicit) {
      result.set(seed, explicit)
      chosen.add(explicit)
      continue
    }
    if (result.has(seed) || automatic.some((item) => item.seed === seed)) continue
    automatic.push({ seed, created: project.time?.created ?? Number.POSITIVE_INFINITY })
  }
  automatic.sort((a, b) => (a.created === b.created ? (a.seed < b.seed ? -1 : 1) : a.created < b.created ? -1 : 1))
  let used = new Set(chosen)
  for (const { seed } of automatic) {
    if (used.size >= PROJECT_FRUITS.length) used = new Set()
    const start = hash(seed) % PROJECT_FRUITS.length
    for (let step = 0; step < PROJECT_FRUITS.length; step++) {
      const fruit = PROJECT_FRUITS[(start + step) % PROJECT_FRUITS.length]
      if (used.has(fruit)) continue
      used.add(fruit)
      result.set(seed, fruit)
      break
    }
  }
  return result
}

const [known, setKnown] = createSignal<ReadonlyMap<string, ProjectFruit>>(new Map())

/** Registers the known projects: from here on `projectFruit` distributes them without repetitions. */
export function registerProjectFruits(projects: readonly FruitProject[]) {
  setKnown(assignProjectFruits(projects))
}

/** The fruit of a project: the chosen one, otherwise the one assigned automatically. */
export function projectFruit(project: FruitProject): ProjectFruit {
  const seed = projectFruitSeed(project)
  return storedFruit(project.icon?.color) ?? known().get(seed) ?? hashed(seed)
}
