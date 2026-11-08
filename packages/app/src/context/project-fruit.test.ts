import { describe, expect, test } from "bun:test"
import { PROJECT_FRUITS } from "@opencode-ai/ui/v2/project-fruits"
import { assignProjectFruits, fruitColor, projectFruitSeed, storedFruit, type FruitProject } from "./project-fruit"

const make = (count: number): FruitProject[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${(i * 2654435761 + 12345).toString(16)}${"abcdef0123456789".repeat(2)}${i}`,
    worktree: `C:\\Users\\Alice\\Desktop\\project-${i}`,
    time: { created: 1_700_000_000_000 + i * 86_400_000 },
  }))

const fruitOf = (projects: FruitProject[]) => {
  const map = assignProjectFruits(projects)
  return projects.map((project) => map.get(projectFruitSeed(project)))
}

describe("assignment of fruits to projects", () => {
  test("it is stable: same project, same fruit, in any order", () => {
    const projects = make(10)
    const first = fruitOf(projects)
    expect(fruitOf(projects)).toEqual(first)
    const shuffled = [...projects].reverse()
    expect(fruitOf(shuffled)).toEqual([...first].reverse())
  })

  test("a new project does not change the fruits of the existing ones", () => {
    const projects = make(12)
    const before = fruitOf(projects.slice(0, 11))
    const after = fruitOf(projects)
    expect(after.slice(0, 11)).toEqual(before)
  })

  test("up to 16 projects no fruit repeats", () => {
    for (const count of [2, 5, 8, 12, 16]) {
      const fruits = fruitOf(make(count))
      expect(new Set(fruits).size).toBe(count)
      for (const fruit of fruits) expect(PROJECT_FRUITS).toContain(fruit!)
    }
  })

  test("beyond 16 projects the fruits are reused uniformly", () => {
    const fruits = fruitOf(make(40))
    expect(fruits.every(Boolean)).toBe(true)
    const counts = new Map<string, number>()
    for (const fruit of fruits) counts.set(fruit!, (counts.get(fruit!) ?? 0) + 1)
    expect(counts.size).toBe(PROJECT_FRUITS.length)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3)
  })

  test("the user's choice wins and their fruit is not given to others", () => {
    const projects = make(15)
    const auto = fruitOf(projects)
    const wanted = auto[3]!
    const others = projects.map((project, i) =>
      i === 7 ? { ...project, icon: { color: fruitColor(wanted) } } : project,
    )
    const result = fruitOf(others)
    expect(result[7]).toBe(wanted)
    expect(result.filter((fruit) => fruit === wanted)).toHaveLength(1)
    expect(new Set(result).size).toBe(15)
  })

  test("old colors and unknown values do not count", () => {
    expect(storedFruit("pink")).toBeUndefined()
    expect(storedFruit("fruit:durian")).toBeUndefined()
    expect(storedFruit("fruit:pear")).toBe("pear")
    expect(storedFruit(undefined)).toBeUndefined()
    const projects = make(4)
    const legacy = projects.map((project) => ({ ...project, icon: { color: "pink" } }))
    expect(fruitOf(legacy)).toEqual(fruitOf(projects))
  })

  test("without a git id the seed is the path, the same with or without a trailing slash", () => {
    expect(projectFruitSeed({ id: "global", worktree: "C:\\Users\\Alice\\x\\" })).toBe(
      projectFruitSeed({ worktree: "C:/Users/Alice/x" }),
    )
    expect(projectFruitSeed({ id: "abc123", worktree: "C:/anything" })).toBe("abc123")
  })

  test("the same copy seen twice counts once", () => {
    const [project] = make(1)
    expect(assignProjectFruits([project, { ...project }]).size).toBe(1)
  })
})
