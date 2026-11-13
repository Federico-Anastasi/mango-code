import { describe, expect, test } from "bun:test"
import {
  filterReviewFiles,
  reviewDiffDirectory,
  reviewDiffKinds,
  reviewDiffNeedsLoad,
  reviewDiffRequests,
} from "./review-diff-kinds"

describe("reviewDiffKinds", () => {
  test("maps file and directory kinds", () => {
    const kinds = reviewDiffKinds([
      { file: "src/a.ts", additions: 1, deletions: 0, status: "added" },
      { file: "src/b.ts", additions: 0, deletions: 2, status: "deleted" },
    ])

    expect(kinds.get("src/a.ts")).toBe("add")
    expect(kinds.get("src/b.ts")).toBe("del")
    expect(kinds.get("src")).toBe("mix")
  })

  test("normalizes file and directory paths", () => {
    const kinds = reviewDiffKinds([{ file: "\\src//lib/a.ts/", additions: 1, deletions: 1, status: "modified" }])

    expect(kinds.get("src/lib/a.ts")).toBe("mix")
    expect(kinds.get("src/lib")).toBe("mix")
  })
})

describe("filterReviewFiles", () => {
  test("filters by path substring", () => {
    const files = ["src/a.ts", "src/b.ts", "lib/c.ts"]
    expect(filterReviewFiles(files, "b.ts")).toEqual(["src/b.ts"])
    expect(filterReviewFiles(files, "")).toEqual(files)
  })
})

describe("reviewDiffNeedsLoad", () => {
  test("loads changed files whose aggregate patch has no hunks", () => {
    expect(
      reviewDiffNeedsLoad({
        file: "src/a.ts",
        additions: 1,
        deletions: 0,
        patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts",
      }),
    ).toBe(true)
  })

  test("keeps complete patches and empty changes", () => {
    expect(
      reviewDiffNeedsLoad({
        file: "src/a.ts",
        additions: 1,
        deletions: 0,
        patch: "@@ -0,0 +1 @@\n+value",
      }),
    ).toBe(false)
    expect(reviewDiffNeedsLoad({ file: "empty.txt", additions: 0, deletions: 0 })).toBe(false)
  })
})

describe("reviewDiffDirectory", () => {
  test("scopes nested files to their parent directory", () => {
    expect(reviewDiffDirectory("/repo", "src/lib/a.ts")).toBe("/repo/src/lib")
    expect(reviewDiffDirectory("C:\\repo", "src/lib/a.ts")).toBe("C:\\repo\\src\\lib")
  })

  test("does not rescope root files", () => {
    expect(reviewDiffDirectory("/repo/", "README.md")).toBe("/repo")
    expect(reviewDiffDirectory("/", "README.md")).toBe("/")
    expect(reviewDiffDirectory("C:\\", "README.md")).toBe("C:\\")
    expect(reviewDiffDirectory("/", "src/a.ts")).toBe("/src")
    expect(reviewDiffDirectory("C:\\", "src/a.ts")).toBe("C:\\src")
  })
})

describe("reviewDiffRequests", () => {
  // The agent names a changed file from the folder it is asked about: from the file's own folder, the name alone.
  test("asks the file's own folder by its name, then the project by its path", () => {
    expect(reviewDiffRequests("C:\\Progetti\\Contabilità prova B", "sub/x.md")).toEqual([
      { directory: "C:\\Progetti\\Contabilità prova B\\sub", file: "x.md", context: undefined },
      { directory: "C:\\Progetti\\Contabilità prova B", file: "sub/x.md", context: 3 },
    ])
    expect(reviewDiffRequests("/repo/project/", "src/lib/a.ts")).toEqual([
      { directory: "/repo/project/src/lib", file: "a.ts", context: undefined },
      { directory: "/repo/project", file: "src/lib/a.ts", context: 3 },
    ])
  })

  test("a file at the top of the project is asked from the project only", () => {
    expect(reviewDiffRequests("C:\\Progetti\\Contabilità prova B", "fatture.md")).toEqual([
      { directory: "C:\\Progetti\\Contabilità prova B", file: "fatture.md", context: 3 },
    ])
  })
})
